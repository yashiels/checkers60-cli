import { CONFIG } from "./config.js";

export class APIError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    public path: string
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
  timeoutMs?: number;
  /**
   * External abort signal. Combined with the per-call timeout into one effective
   * abort; if it fires, the call rejects with {@link ExternalAbortError} (terminal).
   */
  signal?: AbortSignal;
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
  const { headers = {}, json, form, timeoutMs = 30_000, signal } = options;

  const finalHeaders: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "cache-control": "no-cache, no-store",
    "user-agent": CONFIG.USER_AGENT,
    ...headers,
  };

  let body: string | undefined;
  if (form !== undefined) {
    // App quirk: form-urlencoded content-type, JSON payload as a form key.
    finalHeaders["content-type"] = "application/x-www-form-urlencoded";
    body = `${encodeURIComponent(JSON.stringify(form))}=`;
  } else if (json !== undefined) {
    if (!finalHeaders["content-type"]) finalHeaders["content-type"] = "application/json";
    body = JSON.stringify(json);
  }

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
    // The abort must stay active THROUGH the body read: fetch() and resp.text()
    // both run inside the timed/abortable window so a hung body read can be
    // cancelled by the timeout or the external signal.
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
      throw new APIError(resp.status, resp.statusText, text, new URL(url).pathname);
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
