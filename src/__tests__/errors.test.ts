import { describe, it, expect } from "vitest";
import {
  classifyError,
  UsageError,
  EXIT_FAILURE,
  EXIT_USAGE,
  EXIT_AUTH,
  EXIT_NETWORK,
} from "../lib/errors.js";
import { APIError } from "../lib/api.js";

const SECRET_BODY =
  '{"refresh_token":"super-secret-xyz","message":"internal detail leaked"}';

describe("classifyError — exit code mapping", () => {
  it("maps UsageError to exit 2", () => {
    const c = classifyError(new UsageError("bad flag"));
    expect(c.code).toBe(EXIT_USAGE);
    expect(c.message).toBe("bad flag");
  });

  it("maps 401/403 API errors to exit 3 (auth) with status", () => {
    for (const status of [401, 403]) {
      const c = classifyError(new APIError(status, "Unauthorized", SECRET_BODY, "/x"));
      expect(c.code).toBe(EXIT_AUTH);
      expect(c.status).toBe(status);
    }
  });

  it("maps other API errors to exit 1 (generic) with status", () => {
    const c = classifyError(new APIError(500, "Server Error", SECRET_BODY, "/orders"));
    expect(c.code).toBe(EXIT_FAILURE);
    expect(c.status).toBe(500);
  });

  it("maps 'Not logged in' to exit 3 (auth)", () => {
    const c = classifyError(new Error("Not logged in. Run checkers60 login."));
    expect(c.code).toBe(EXIT_AUTH);
  });

  it.each([
    ["fetch failed", new Error("fetch failed")],
    ["timeout/abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["ECONNREFUSED", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ["ENOTFOUND", Object.assign(new Error("dns"), { code: "ENOTFOUND" })],
    ["ETIMEDOUT", Object.assign(new Error("slow"), { code: "ETIMEDOUT" })],
  ])("maps network failure (%s) to exit 4", (_label, err) => {
    expect(classifyError(err).code).toBe(EXIT_NETWORK);
  });

  it("maps a plain runtime error to exit 1", () => {
    expect(classifyError(new Error("boom")).code).toBe(EXIT_FAILURE);
  });

  it("maps a non-Error throw to exit 1", () => {
    expect(classifyError("weird").code).toBe(EXIT_FAILURE);
  });
});

describe("classifyError — never leaks the response body", () => {
  it("excludes APIError.body from the user-facing message (all statuses)", () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const c = classifyError(new APIError(status, "X", SECRET_BODY, "/secret"));
      expect(c.message).not.toContain("super-secret-xyz");
      expect(c.message).not.toContain("internal detail leaked");
    }
  });

  it("keeps any verbose status line body-free and query-free", () => {
    const c = classifyError(new APIError(500, "X", SECRET_BODY, "/tokens"));
    if (c.verboseLine) {
      expect(c.verboseLine).not.toContain("super-secret-xyz");
      expect(c.verboseLine).not.toContain("?");
    }
  });
});
