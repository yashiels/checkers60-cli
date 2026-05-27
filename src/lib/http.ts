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
  const { headers = {}, json, form, timeoutMs = 30_000 } = options;

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const path = new URL(url).pathname;
    throw new APIError(resp.status, resp.statusText, text, path);
  }

  return { status: resp.status, headers: resp.headers, data: data as T };
}
