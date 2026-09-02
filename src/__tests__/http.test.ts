import { describe, it, expect, vi, afterEach } from "vitest";
import {
  request,
  APIError,
  TimeoutError,
  ExternalAbortError,
  redactUrl,
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
  { status = 200, statusText = "OK" }: { status?: number; statusText?: string } = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
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
