import { describe, it, expect, afterEach, vi } from "vitest";
import { Octokit } from "@octokit/rest";
import { createClient } from "../../../src/core/github/client.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("createClient", () => {
  const originalEnv = process.env.GITHUB_PAT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GITHUB_PAT;
    } else {
      process.env.GITHUB_PAT = originalEnv;
    }
  });

  it("returns an Octokit instance when GITHUB_PAT is set", () => {
    process.env.GITHUB_PAT = "ghp_test_token";
    const client = createClient();
    expect(client).toBeInstanceOf(Octokit);
  });

  it("passes the PAT through to the Octokit constructor as `auth`", () => {
    const ctor = vi.fn();
    createClient({
      readToken: () => "ghp_injected_token",
      OctokitCtor: ctor as unknown as new (options: { auth: string }) => Octokit,
    });
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith({ auth: "ghp_injected_token" });
  });

  it("reads the token from injected deps rather than process.env when provided", () => {
    process.env.GITHUB_PAT = "env_token_should_be_ignored";
    const ctor = vi.fn();
    createClient({
      readToken: () => "dep_token_wins",
      OctokitCtor: ctor as unknown as new (options: { auth: string }) => Octokit,
    });
    expect(ctor).toHaveBeenCalledWith({ auth: "dep_token_wins" });
  });

  it("throws ClawError when GITHUB_PAT is not set", () => {
    delete process.env.GITHUB_PAT;
    expect(() => createClient()).toThrow(ClawError);
  });

  it("throws ClawError when GITHUB_PAT is the empty string", () => {
    process.env.GITHUB_PAT = "";
    expect(() => createClient()).toThrow(ClawError);
  });

  it("throws ClawError when the token is whitespace only", () => {
    // A paste error or trailing newline from a secrets manager must surface
    // as a friendly `ClawError` rather than a silent 401 on the first API
    // call.
    expect(() => createClient({ readToken: () => "   " })).toThrow(ClawError);
    expect(() => createClient({ readToken: () => "\n\t" })).toThrow(ClawError);
  });

  it("trims surrounding whitespace from the token before passing it to Octokit", () => {
    const ctor = vi.fn();
    createClient({
      readToken: () => "  ghp_padded_token\n",
      OctokitCtor: ctor as unknown as new (options: { auth: string }) => Octokit,
    });
    expect(ctor).toHaveBeenCalledWith({ auth: "ghp_padded_token" });
  });

  it("throws a ClawError with the expected message and hint format", () => {
    const error = (() => {
      try {
        createClient({ readToken: () => undefined });
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ClawError);
    const clawError = error as ClawError;
    // Matches the standard surfacing format defined in CLAUDE.md —
    // `message` is "what is wrong", `hint` is "what to do".
    expect(clawError.message).toBe("GITHUB_PAT is not set.");
    expect(clawError.hint).toBe(
      "Add GITHUB_PAT to your .env file. See .env.example for the required format.",
    );
    expect(clawError.name).toBe("ClawError");
  });

  it("does not call the Octokit constructor when the token is missing", () => {
    const ctor = vi.fn();
    expect(() =>
      createClient({
        readToken: () => undefined,
        OctokitCtor: ctor as unknown as new (options: { auth: string }) => Octokit,
      }),
    ).toThrow(ClawError);
    expect(ctor).not.toHaveBeenCalled();
  });
});
