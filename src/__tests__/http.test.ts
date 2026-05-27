import { describe, it, expect, vi, afterEach } from "vitest";
import { request, APIError } from "../lib/http.js";

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
