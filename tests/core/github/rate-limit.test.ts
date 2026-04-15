import { describe, expect, it } from "vitest";
import {
  isRateLimitError,
  toRateLimitClawError,
  withRateLimitHandling,
} from "../../../src/core/github/rate-limit.js";
import { ClawError } from "../../../src/core/types/errors.js";

/** Build an Octokit-shaped error object the helpers will recognise. */
function octokitError(
  status: number,
  headers: Record<string, string> = {},
): Record<string, unknown> {
  return {
    status,
    response: { headers },
  };
}

describe("isRateLimitError", () => {
  it("matches a 429 regardless of headers", () => {
    expect(isRateLimitError(octokitError(429))).toBe(true);
    expect(
      isRateLimitError(octokitError(429, { "x-ratelimit-remaining": "42" })),
    ).toBe(true);
  });

  it("matches a 403 with remaining=0", () => {
    expect(
      isRateLimitError(octokitError(403, { "x-ratelimit-remaining": "0" })),
    ).toBe(true);
  });

  it("rejects a 403 with remaining > 0 (real permission error)", () => {
    expect(
      isRateLimitError(octokitError(403, { "x-ratelimit-remaining": "42" })),
    ).toBe(false);
  });

  it("rejects a 403 without the ratelimit header", () => {
    expect(isRateLimitError(octokitError(403))).toBe(false);
  });

  it("rejects unrelated status codes and non-object values", () => {
    expect(isRateLimitError(octokitError(500))).toBe(false);
    expect(isRateLimitError(new Error("boom"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("nope")).toBe(false);
  });
});

describe("toRateLimitClawError", () => {
  it("surfaces the reset timestamp from the response header", () => {
    const err = toRateLimitClawError(
      octokitError(429, { "x-ratelimit-reset": "1700000000" }),
    );
    expect(err).toBeInstanceOf(ClawError);
    expect(err.message).toBe("GitHub API rate limit reached.");
    expect(err.hint).toContain("2023-11-14T22:13:20.000Z");
  });

  it("falls back to a generic hint when no reset header is present", () => {
    const err = toRateLimitClawError(octokitError(429));
    expect(err.hint).toContain("Run `claw status` to re-check once resolved.");
    // No ISO timestamp leaked from an undefined header.
    expect(err.hint).not.toContain("1970");
  });

  it("uses the fallback hint when the reset header is non-numeric", () => {
    const err = toRateLimitClawError(
      octokitError(429, { "x-ratelimit-reset": "nope" }),
    );
    expect(err.hint).toContain("Run `claw status`");
  });
});

describe("withRateLimitHandling", () => {
  it("returns the inner value on success", async () => {
    const result = await withRateLimitHandling(async () => 42);
    expect(result).toBe(42);
  });

  it("translates rate-limit errors into formatted ClawErrors", async () => {
    await expect(
      withRateLimitHandling(async () => {
        throw octokitError(429);
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    const err = new Error("not a rate limit");
    await expect(
      withRateLimitHandling(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});
