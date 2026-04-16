import { describe, expect, it } from "vitest";
import { ClawError } from "../../../src/core/types/errors.js";
import { toClawError } from "../../../src/core/loop/safe-error.js";

describe("toClawError", () => {
  it("returns a ClawError unchanged", () => {
    const original = new ClawError("foo.", "bar");
    expect(toClawError(original)).toBe(original);
  });

  it("preserves the ClawError hint when re-throwing through the wrapper", () => {
    const original = new ClawError("foo.", "do bar");
    const wrapped = toClawError(original);
    expect(wrapped.message).toBe("foo.");
    expect(wrapped.hint).toBe("do bar");
  });

  it("wraps a generic Error and keeps the message", () => {
    const wrapped = toClawError(new Error("network down"));
    expect(wrapped).toBeInstanceOf(ClawError);
    expect(wrapped.message).toBe("network down");
    expect(wrapped.hint).toBeUndefined();
  });

  it("wraps an empty-message Error with a fallback string", () => {
    const wrapped = toClawError(new Error(""));
    expect(wrapped.message).toBe("unexpected error.");
  });

  it("wraps non-Error throwables with a fallback string", () => {
    expect(toClawError("string error").message).toBe("unexpected error.");
    expect(toClawError(null).message).toBe("unexpected error.");
    expect(toClawError(undefined).message).toBe("unexpected error.");
    expect(toClawError(42).message).toBe("unexpected error.");
  });

  it("does NOT serialize an Octokit-shaped error's request headers (PAT safety)", () => {
    // Simulate Octokit's RequestError shape — message is just verb+url+status,
    // but `request.headers.authorization` carries the PAT. The wrapper must
    // never copy the headers anywhere callers might log them.
    class MockOctokitError extends Error {
      public readonly status = 403;
      public readonly request = {
        headers: { authorization: "token ghp_super_secret_pat_token" },
      };
      public readonly response = {
        headers: { "x-ratelimit-remaining": "0" },
      };
    }
    const wrapped = toClawError(
      new MockOctokitError("GET /repos/foo/bar - 403"),
    );
    // Only the message survives. No serialization of the full object.
    expect(wrapped.message).toBe("GET /repos/foo/bar - 403");
    expect(wrapped.hint).toBeUndefined();
    // Defensive — make sure the PAT is not anywhere in the rendered surface.
    expect(JSON.stringify(wrapped)).not.toContain("ghp_super_secret_pat_token");
  });
});
