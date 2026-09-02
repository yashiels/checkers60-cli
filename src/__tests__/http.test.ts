import { describe, it, expect, vi, afterEach } from "vitest";
import {
  request,
  APIError,
  TimeoutError,
  ExternalAbortError,
  redactUrl,
  parseRetryAfter,
  MAX_ATTEMPTS,
} from "../lib/http.js";

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/** fetch mock that rejects with an AbortError once its (internal) signal aborts. */
function abortAwareFetch(bodyNeverResolves = false) {
  return vi.fn((_url: string, init: { signal: AbortSignal }): Promise<Response> => {
    if (init.signal.aborted) return Promise.reject(abortError());
    if (bodyNeverResolves) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(abortError()));
          }),
      } as unknown as Response);
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(abortError()));
    });
  });
}

function fakeResponse(
  body: unknown,
  {
    status = 200,
    statusText = "OK",
    headers = {},
  }: { status?: number; statusText?: string; headers?: Record<string, string> } = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(headers),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** fetch mock that returns/throws one step per call, repeating the last step. */
function stepFetch(steps: Array<Response | Error>) {
  let i = 0;
  return vi.fn((): Promise<Response> => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  });
}

interface FetchInit {
  headers: Record<string, string>;
  body?: string;
  method?: string;
}

function makeFetchMock() {
  return vi.fn(
    (_url: string, _init: FetchInit): Promise<Response> =>
      Promise.resolve(fakeResponse({ ok: true }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request body encoding", () => {
  it("encodes a form body as encodeURIComponent(JSON)+'=' under form content-type", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const payload = { a: 1, b: "x y", nested: { z: [1, 2] } };
    await request("POST", "https://example.com/api", { form: payload });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe(`${encodeURIComponent(JSON.stringify(payload))}=`);
  });

  it("encodes a json body with JSON.stringify under json content-type", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const payload = { a: 1 };
    await request("POST", "https://example.com/api", { json: payload });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(payload));
  });

  it("sends no body and no content-type for a plain GET", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await request("GET", "https://example.com/api");

    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBeUndefined();
    expect(init.headers["content-type"]).toBeUndefined();
  });
});

describe("request response handling", () => {
  it("parses JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ hello: "world" })));
    const res = await request<{ hello: string }>("GET", "https://example.com/x");
    expect(res.data.hello).toBe("world");
  });

  it("throws APIError on non-2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse("nope", { status: 500 })));
    await expect(request("GET", "https://example.com/boom")).rejects.toBeInstanceOf(APIError);
  });
});

describe("redactUrl", () => {
  it("keeps origin+pathname and drops the query string", () => {
    expect(redactUrl("https://example.com/tokens?refreshToken=SECRET&x=1")).toBe(
      "https://example.com/tokens"
    );
  });

  it("keeps a bare origin+pathname unchanged", () => {
    expect(redactUrl("https://example.com/a/b")).toBe("https://example.com/a/b");
  });
});

describe("request abort + timeout", () => {
  it("rejects with an external-abort error, distinct from a timeout", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const ext = new AbortController();
    const p = request("GET", "https://example.com/x", {
      signal: ext.signal,
      timeoutMs: 10_000,
    });
    ext.abort();

    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err.external).toBe(true);
    expect(err.name).toBe("AbortError");
  });

  it("rejects immediately when the external signal is already aborted", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const ext = new AbortController();
    ext.abort();
    const err = await request("GET", "https://example.com/x", { signal: ext.signal }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(ExternalAbortError);
  });

  it("times out a hanging body read (resp.text never resolves)", async () => {
    vi.stubGlobal("fetch", abortAwareFetch(true));
    const err = await request("GET", "https://example.com/slow", { timeoutMs: 20 }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.external).toBeUndefined();
  });

  it("times out a hanging fetch, distinct from an external abort", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const err = await request("GET", "https://example.com/slow", { timeoutMs: 20 }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(ExternalAbortError);
  });
});

describe("request error redaction", () => {
  const secretUrl = "https://example.com/tokens?refreshToken=SECRET123&foo=bar";

  it("keeps the refresh token out of timeout messages", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const err = await request("GET", secretUrl, { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("https://example.com/tokens");
    expect(err.message).not.toContain("SECRET123");
    expect(err.message).not.toContain("refreshToken");
    expect(err.message).not.toContain("?");
  });

  it("keeps the refresh token out of external-abort messages", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const ext = new AbortController();
    const p = request("GET", secretUrl, { signal: ext.signal, timeoutMs: 10_000 });
    ext.abort();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect(err.message).not.toContain("SECRET123");
    expect(err.message).not.toContain("refreshToken");
    expect(err.message).not.toContain("?");
  });
});

describe("request cleanup", () => {
  it("clears the timer and removes the external listener on success", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: true })));
    const ext = new AbortController();
    const removeSpy = vi.spyOn(ext.signal, "removeEventListener");

    await request("GET", "https://example.com/x", { signal: ext.signal });

    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    // Listener is gone: aborting after completion is inert.
    expect(() => ext.abort()).not.toThrow();
  });

  it("clears the timer and removes the external listener on the APIError path", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse("nope", { status: 500 })));
    const ext = new AbortController();
    const removeSpy = vi.spyOn(ext.signal, "removeEventListener");

    await expect(
      request("GET", "https://example.com/boom", { signal: ext.signal })
    ).rejects.toBeInstanceOf(APIError);

    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
  });
});

describe("parseRetryAfter", () => {
  it("parses the delta-seconds form and converts to ms", () => {
    expect(parseRetryAfter("2", 60_000)).toBe(2000);
  });

  it("parses the HTTP-date form relative to now", () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(when, 60_000);
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it("caps the parsed delay at capMs", () => {
    expect(parseRetryAfter("3600", 5000)).toBe(5000);
    const farFuture = new Date(Date.now() + 3_600_000).toUTCString();
    expect(parseRetryAfter(farFuture, 5000)).toBe(5000);
  });

  it("returns undefined for an absent or unparseable value", () => {
    expect(parseRetryAfter(undefined, 60_000)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", 60_000)).toBeUndefined();
  });
});

describe("request retry policy", () => {
  const fast = { retry: "safe" as const, backoffBaseMs: 1, backoffCapMs: 2 };

  it("retries a 503 then succeeds (safe)", async () => {
    const fetchMock = stepFetch([
      fakeResponse("busy", { status: 503, statusText: "Service Unavailable" }),
      fakeResponse({ ok: true }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request<{ ok: boolean }>("GET", "https://example.com/x", fast);
    expect(res.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a pre-response network error then succeeds (safe)", async () => {
    const fetchMock = stepFetch([new TypeError("network down"), fakeResponse({ ok: true })]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request<{ ok: boolean }>("GET", "https://example.com/x", fast);
    expect(res.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 (non-retryable status)", async () => {
    const fetchMock = stepFetch([fakeResponse("bad", { status: 400 })]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(request("GET", "https://example.com/x", fast)).rejects.toBeInstanceOf(APIError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a mutation / retry:\"never\" call at all", async () => {
    const fetchMock = stepFetch([fakeResponse("busy", { status: 503 })]);
    vi.stubGlobal("fetch", fetchMock);

    // Default policy is "never".
    await expect(request("POST", "https://example.com/cart", { json: {} })).rejects.toBeInstanceOf(
      APIError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries an external abort and never relabels it as a timeout", async () => {
    vi.stubGlobal("fetch", abortAwareFetch());
    const ext = new AbortController();
    const p = request("GET", "https://example.com/x", {
      ...fast,
      signal: ext.signal,
      timeoutMs: 10_000,
    });
    ext.abort();

    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAbortError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("honors and caps a Retry-After header (seconds form)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = stepFetch([
      fakeResponse("busy", { status: 503, headers: { "retry-after": "3600" } }),
      fakeResponse({ ok: true }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request<{ ok: boolean }>("GET", "https://example.com/x", {
      retry: "safe",
      retryAfterCapMs: 40,
    });
    expect(res.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The backoff wait is the capped Retry-After (40ms), never the raw 3600s.
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(40);
    expect(delays.every((d) => (d ?? 0) < 3_600_000)).toBe(true);
  });

  it("honors a Retry-After header in HTTP-date form", async () => {
    const when = new Date(Date.now() + 20).toUTCString();
    const fetchMock = stepFetch([
      fakeResponse("busy", { status: 503, headers: { "retry-after": when } }),
      fakeResponse({ ok: true }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request<{ ok: boolean }>("GET", "https://example.com/x", {
      retry: "safe",
      retryAfterCapMs: 60_000,
    });
    expect(res.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds total retrying by the overall time budget", async () => {
    // Budget is too small to afford even a second attempt's backoff.
    const fetchMock = stepFetch([fakeResponse("busy", { status: 503 })]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request("GET", "https://example.com/x", {
        retry: "safe",
        retryBudgetMs: 5,
        backoffBaseMs: 1000,
      })
    ).rejects.toBeInstanceOf(APIError);
    // Fewer than the max attempts because the budget ran out.
    expect(fetchMock.mock.calls.length).toBeLessThan(MAX_ATTEMPTS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects the max-3-attempts ceiling", async () => {
    const fetchMock = stepFetch([fakeResponse("busy", { status: 503 })]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(request("GET", "https://example.com/x", fast)).rejects.toBeInstanceOf(APIError);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
