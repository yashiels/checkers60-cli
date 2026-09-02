import { CONFIG } from "./config.js";

export class APIError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    public path: string,
    /** Raw `Retry-After` header value, when the server sent one. */
    public retryAfter?: string
  ) {
    super(`API ${status} ${statusText} on ${path}: ${body.slice(0, 200)}`);
    this.name = "APIError";
  }
}

/**
 * Thrown when the per-call timeout elapses. Distinct from {@link ExternalAbortError}
 * so a later retry policy can treat a timeout as retryable while an external abort
 * stays terminal.
 */
export class TimeoutError extends Error {
  readonly timeout = true;
  constructor(
    public timeoutMs: number,
    method: string,
    redactedUrl: string
  ) {
    super(`Request timed out after ${timeoutMs}ms: ${method} ${redactedUrl}`);
    this.name = "TimeoutError";
  }
}

/**
 * Thrown when an external {@link AbortSignal} passed via `options.signal` aborts
 * the call. Terminal: a later retry policy must never retry it and must never
 * relabel it as a timeout. Carries `external === true` as the discriminator.
 */
export class ExternalAbortError extends Error {
  readonly external = true;
  constructor(method: string, redactedUrl: string) {
    super(`Request aborted: ${method} ${redactedUrl}`);
    this.name = "AbortError";
  }
}

/** Origin + pathname only — strips query string (and any refresh token in it). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** JSON body — serialized with JSON.stringify and `application/json`. */
  json?: unknown;
  /**
   * Form body — the mobile app quirk: the JSON payload is sent under
   * `content-type: application/x-www-form-urlencoded` as a single urlencoded
   * form key with an empty value, i.e. `encodeURIComponent(JSON.stringify(x)) + "="`.
   */
  form?: unknown;
  /** Per-attempt timeout (fetch + body read). Defaults to 30s. */
  timeoutMs?: number;
  /**
   * External abort signal. Combined with the per-call timeout into one effective
   * abort; if it fires, the call rejects with {@link ExternalAbortError} (terminal).
   */
  signal?: AbortSignal;
  /**
   * Retry policy. `"never"` (the default) makes exactly one attempt. `"safe"`
   * — reserved for provably side-effect-free reads — retries up to
   * {@link MAX_ATTEMPTS} times on pre-response network errors, per-attempt
   * timeouts, and HTTP 429/502/503/504. An external abort is NEVER retried.
   */
  retry?: "safe" | "never";
  /**
   * Overall wall-clock budget for a `"safe"` call, spanning every attempt, its
   * body read, and the backoff waits between them. Defaults to 90s.
   */
  retryBudgetMs?: number;
  /** Base for exponential backoff between `"safe"` attempts. Defaults to 300ms. */
  backoffBaseMs?: number;
  /** Ceiling for a single computed backoff wait. Defaults to 8s. */
  backoffCapMs?: number;
  /** Ceiling applied to a server-provided `Retry-After`. Defaults to 20s. */
  retryAfterCapMs?: number;
}

/** Hard ceiling on attempts for a `retry:"safe"` call. */
export const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BUDGET_MS = 90_000;
const DEFAULT_BACKOFF_BASE_MS = 300;
const DEFAULT_BACKOFF_CAP_MS = 8_000;
const DEFAULT_RETRY_AFTER_CAP_MS = 20_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** An external abort ({@link ExternalAbortError} or any `{ external: true }` marker). */
function isExternalAbort(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { external?: unknown }).external === true);
}

/**
 * Whether a failed attempt may be retried by a `"safe"` call. External aborts are
 * terminal and handled before this is consulted. An {@link APIError} is retryable
 * only for 429/502/503/504; every other network-level failure (including a
 * per-attempt {@link TimeoutError}) is treated as a retryable pre-response error.
 */
function isRetryable(err: unknown): boolean {
  if (isExternalAbort(err)) return false;
  if (err instanceof APIError) return RETRYABLE_STATUS.has(err.status);
  return true;
}

/**
 * Parse a `Retry-After` header — both the delta-seconds form (`"120"`) and the
 * HTTP-date form (`"Wed, 21 Oct 2026 07:28:00 GMT"`) — into milliseconds,
 * clamped to `[0, capMs]`. Returns `undefined` when absent or unparseable.
 */
export function parseRetryAfter(
  value: string | undefined | null,
  capMs: number
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, Math.min(ms, capMs));
}

/** Abortable delay. Resolves after `ms`; rejects with {@link ExternalAbortError} if `signal` fires. */
function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
  method: string,
  redactedUrl: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExternalAbortError(method, redactedUrl));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ExternalAbortError(method, redactedUrl));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

/**
 * Low-level HTTP helper for the Sixty60 mobile API. Mirrors the headers and
 * body-encoding behaviour reverse-engineered from the Android app.
 */
export async function request<T = unknown>(
  method: string,
  url: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    headers = {},
    json,
    form,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    retry = "never",
    retryBudgetMs = DEFAULT_RETRY_BUDGET_MS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
    retryAfterCapMs = DEFAULT_RETRY_AFTER_CAP_MS,
  } = options;

  const finalHeaders: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "cache-control": "no-cache, no-store",
    "user-agent": CONFIG.USER_AGENT,
    ...headers,
  };

  // Body + headers (and any ids they carry) are built ONCE and reused identically
  // across every retry attempt.
  let body: string | undefined;
  if (form !== undefined) {
    // App quirk: form-urlencoded content-type, JSON payload as a form key.
    finalHeaders["content-type"] = "application/x-www-form-urlencoded";
    body = `${encodeURIComponent(JSON.stringify(form))}=`;
  } else if (json !== undefined) {
    if (!finalHeaders["content-type"]) finalHeaders["content-type"] = "application/json";
    body = JSON.stringify(json);
  }

  // `retry:"never"` — exactly one attempt; original behaviour preserved.
  if (retry !== "safe") {
    return attemptRequest<T>(method, url, finalHeaders, body, timeoutMs, signal);
  }

  const redacted = redactUrl(url);
  const deadline = Date.now() + retryBudgetMs;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      // The per-attempt timeout is bounded by whatever overall budget remains, so
      // the budget also caps a single attempt (fetch + body read).
      const perAttempt = Math.min(timeoutMs, remaining);
      return await attemptRequest<T>(method, url, finalHeaders, body, perAttempt, signal);
    } catch (err) {
      // An external abort is terminal: never retried, never relabeled as a timeout.
      if (isExternalAbort(err)) throw err;
      lastErr = err;
      if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(err)) throw err;

      const retryAfterMs =
        err instanceof APIError ? parseRetryAfter(err.retryAfter, retryAfterCapMs) : undefined;
      const delay =
        retryAfterMs !== undefined
          ? retryAfterMs
          : Math.random() * Math.min(backoffCapMs, backoffBaseMs * 2 ** attempt);

      // Not enough budget to both wait and try again → stop now with the last error.
      if (delay >= deadline - Date.now()) throw err;
      // Backoff is abortable: an external abort during the wait is terminal.
      await abortableSleep(delay, signal, method, redacted);
    }
  }

  throw lastErr;
}

/**
 * A single HTTP attempt: fetch + body read under one combined abort (the
 * per-attempt timeout fanned in with the external signal). The abort stays active
 * THROUGH the body read so a hung `resp.text()` can be cancelled. Rejects with
 * {@link ExternalAbortError} (terminal) on external abort, {@link TimeoutError} on
 * the per-attempt timeout, and {@link APIError} on a non-2xx response (carrying the
 * `Retry-After` header for the retry policy to honor).
 */
async function attemptRequest<T>(
  method: string,
  url: string,
  finalHeaders: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
      signal: controller.signal,
      redirect: "follow",
    });

    const text = await resp.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!resp.ok) {
      throw new APIError(
        resp.status,
        resp.statusText,
        text,
        new URL(url).pathname,
        resp.headers.get("retry-after") ?? undefined
      );
    }

    return { status: resp.status, headers: resp.headers, data: data as T };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // External abort takes precedence and is terminal — never relabel it as a timeout.
      if (signal?.aborted) {
        throw new ExternalAbortError(method, redactUrl(url));
      }
      if (timedOut) {
        throw new TimeoutError(timeoutMs, method, redactUrl(url));
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (onExternalAbort) signal?.removeEventListener("abort", onExternalAbort);
  }
}
