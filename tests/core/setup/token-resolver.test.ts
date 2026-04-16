import { describe, it, expect } from "vitest";
import { resolveOne, resolveTokens } from "../../../src/core/setup/token-resolver.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("resolveOne — priority order", () => {
  it("prefers the CLI flag over env and file", () => {
    const resolved = resolveOne("GITHUB_PAT", "flag", "env", "file");
    expect(resolved).toEqual({ value: "flag", source: "flag" });
  });

  it("falls through to env when the flag is undefined", () => {
    const resolved = resolveOne("GITHUB_PAT", undefined, "env", "file");
    expect(resolved).toEqual({ value: "env", source: "env" });
  });

  it("falls through to the env file when flag and env are undefined", () => {
    const resolved = resolveOne("GITHUB_PAT", undefined, undefined, "file");
    expect(resolved).toEqual({ value: "file", source: "env-file" });
  });

  it("treats whitespace-only as empty for every source", () => {
    const resolved = resolveOne("GITHUB_PAT", "   ", "\t", "actual");
    expect(resolved.source).toBe("env-file");
    expect(resolved.value).toBe("actual");
  });

  it("trims trailing newlines from the resolved value", () => {
    const resolved = resolveOne("GITHUB_PAT", "ghp_with_newline\n", undefined, undefined);
    expect(resolved.value).toBe("ghp_with_newline");
  });

  it("throws ClawError when every source is empty", () => {
    let caught: unknown;
    try {
      resolveOne("GITHUB_PAT", undefined, undefined, undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    expect((caught as ClawError).message).toBe("GITHUB_PAT is not set.");
    expect((caught as ClawError).hint).toContain("--github-pat");
  });

  it("uses the right flag name for CLAUDE_CODE_OAUTH_TOKEN", () => {
    let caught: unknown;
    try {
      resolveOne("CLAUDE_CODE_OAUTH_TOKEN", undefined, undefined, undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    expect((caught as ClawError).hint).toContain("--claude-token");
  });

  it("does not echo the token in the error message", () => {
    let caught: unknown;
    try {
      resolveOne("GITHUB_PAT", undefined, undefined, "  ");
    } catch (err) {
      caught = err;
    }
    const message = (caught as ClawError).message;
    expect(message).not.toContain("ghp_");
  });
});

describe("resolveTokens — full priority pipeline", () => {
  it("reads both tokens from the environment when no overrides", async () => {
    const resolved = await resolveTokens(
      "/tmp/proj",
      {},
      {
        readEnv: (key) => {
          if (key === "GITHUB_PAT") return "ghp_env";
          if (key === "CLAUDE_CODE_OAUTH_TOKEN") return "clm_env";
          return undefined;
        },
        envFileFs: { readFile: async () => null },
      },
    );
    expect(resolved.githubPat).toEqual({ value: "ghp_env", source: "env" });
    expect(resolved.claudeToken).toEqual({ value: "clm_env", source: "env" });
  });

  it("reads from .claw/.env when env vars are unset", async () => {
    const resolved = await resolveTokens(
      "/tmp/proj",
      {},
      {
        readEnv: () => undefined,
        envFileFs: {
          readFile: async () =>
            "GITHUB_PAT=ghp_file\nCLAUDE_CODE_OAUTH_TOKEN=clm_file\n",
        },
      },
    );
    expect(resolved.githubPat.source).toBe("env-file");
    expect(resolved.claudeToken.source).toBe("env-file");
  });

  it("CLI flags beat env and file", async () => {
    const resolved = await resolveTokens(
      "/tmp/proj",
      { githubPat: "flag-pat", claudeToken: "flag-claude" },
      {
        readEnv: (key) =>
          key === "GITHUB_PAT" ? "ghp_env" : "clm_env",
        envFileFs: {
          readFile: async () =>
            "GITHUB_PAT=ghp_file\nCLAUDE_CODE_OAUTH_TOKEN=clm_file\n",
        },
      },
    );
    expect(resolved.githubPat).toEqual({ value: "flag-pat", source: "flag" });
    expect(resolved.claudeToken).toEqual({ value: "flag-claude", source: "flag" });
  });

  it("halts when a single token is missing", async () => {
    await expect(
      resolveTokens(
        "/tmp/proj",
        {},
        {
          readEnv: (key) => (key === "GITHUB_PAT" ? "ghp_only" : undefined),
          envFileFs: { readFile: async () => null },
        },
      ),
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN is not set/);
  });
});
