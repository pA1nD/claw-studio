import { describe, it, expect } from "vitest";
import { loadDotenvIntoProcessEnv } from "../../../src/core/setup/dotenv-loader.js";

describe("loadDotenvIntoProcessEnv", () => {
  it("reports found=false when .claw/.env is missing", async () => {
    const env: NodeJS.ProcessEnv = {};
    const result = await loadDotenvIntoProcessEnv("/tmp/proj", env, {
      readFile: async () => null,
    });
    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
  });

  it("loads tokens into process.env when unset", async () => {
    const env: NodeJS.ProcessEnv = {};
    const result = await loadDotenvIntoProcessEnv("/tmp/proj", env, {
      readFile: async () =>
        "GITHUB_PAT=ghp_from_file\nCLAUDE_CODE_OAUTH_TOKEN=clm_from_file\n",
    });
    expect(result.found).toBe(true);
    expect(env["GITHUB_PAT"]).toBe("ghp_from_file");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("clm_from_file");
    expect(result.applied).toContain("GITHUB_PAT");
    expect(result.applied).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("does NOT clobber values already set in process.env", async () => {
    const env: NodeJS.ProcessEnv = { GITHUB_PAT: "already_set" };
    const result = await loadDotenvIntoProcessEnv("/tmp/proj", env, {
      readFile: async () =>
        "GITHUB_PAT=should_not_win\nCLAUDE_CODE_OAUTH_TOKEN=clm_from_file\n",
    });
    expect(env["GITHUB_PAT"]).toBe("already_set");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("clm_from_file");
    expect(result.applied).not.toContain("GITHUB_PAT");
    expect(result.applied).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("treats an empty env var as unset (so it is filled from the file)", async () => {
    const env: NodeJS.ProcessEnv = { GITHUB_PAT: "" };
    await loadDotenvIntoProcessEnv("/tmp/proj", env, {
      readFile: async () => "GITHUB_PAT=from_file\n",
    });
    expect(env["GITHUB_PAT"]).toBe("from_file");
  });

  it("reports the path that was consulted for diagnostics", async () => {
    const env: NodeJS.ProcessEnv = {};
    const result = await loadDotenvIntoProcessEnv("/tmp/proj", env, {
      readFile: async () => null,
    });
    expect(result.path).toContain(".claw");
    expect(result.path.endsWith(".env")).toBe(true);
  });
});
