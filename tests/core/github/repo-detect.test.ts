import { describe, it, expect } from "vitest";
import {
  detectRepo,
  parseGitRemoteUrl,
  parseRepoString,
} from "../../../src/core/github/repo-detect.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("parseRepoString", () => {
  it("parses a standard owner/repo string", () => {
    expect(parseRepoString("pA1nD/claw-studio")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("trims whitespace and strips a trailing .git", () => {
    expect(parseRepoString("  pA1nD/claw-studio.git  ")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("throws ClawError on malformed input", () => {
    expect(() => parseRepoString("not-a-repo")).toThrow(ClawError);
    expect(() => parseRepoString("too/many/slashes")).toThrow(ClawError);
    expect(() => parseRepoString("")).toThrow(ClawError);
  });
});

describe("parseGitRemoteUrl", () => {
  it("parses SSH remotes", () => {
    expect(parseGitRemoteUrl("git@github.com:pA1nD/claw-studio.git")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("parses SSH remotes without the .git suffix", () => {
    expect(parseGitRemoteUrl("git@github.com:pA1nD/claw-studio")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("parses HTTPS remotes", () => {
    expect(parseGitRemoteUrl("https://github.com/pA1nD/claw-studio.git")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("parses HTTPS remotes without the .git suffix and with a trailing slash", () => {
    expect(parseGitRemoteUrl("https://github.com/pA1nD/claw-studio/")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("parses HTTPS remotes with an embedded credential", () => {
    expect(parseGitRemoteUrl("https://token@github.com/pA1nD/claw-studio.git")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("parses ssh:// protocol remotes", () => {
    expect(parseGitRemoteUrl("ssh://git@github.com/pA1nD/claw-studio.git")).toEqual({
      owner: "pA1nD",
      repo: "claw-studio",
    });
  });

  it("returns null for non-GitHub or unrecognised URLs", () => {
    expect(parseGitRemoteUrl("https://gitlab.com/pA1nD/claw-studio.git")).toBeNull();
    expect(parseGitRemoteUrl("not a url")).toBeNull();
    expect(parseGitRemoteUrl("")).toBeNull();
  });
});

describe("detectRepo", () => {
  // Source 1 — explicit --repo flag wins over everything else
  it("uses the explicit repo when passed", async () => {
    const result = await detectRepo({
      explicit: "pA1nD/claw-studio",
      readConfigFile: async () => '{"repo":"other/config"}',
      readGitRemote: async () => "git@github.com:other/remote.git",
    });
    expect(result).toEqual({ owner: "pA1nD", repo: "claw-studio" });
  });

  it("rejects an invalid explicit repo with ClawError", async () => {
    await expect(detectRepo({ explicit: "not-a-repo" })).rejects.toBeInstanceOf(ClawError);
  });

  // Source 2 — .claw/config.json when no explicit flag
  it("reads repo from .claw/config.json when no explicit flag is passed", async () => {
    const result = await detectRepo({
      cwd: "/fake/project",
      readConfigFile: async () => '{"repo":"owner/from-config"}',
      readGitRemote: async () => "git@github.com:other/remote.git",
    });
    expect(result).toEqual({ owner: "owner", repo: "from-config" });
  });

  it("falls through when .claw/config.json is malformed or missing a repo field", async () => {
    const result = await detectRepo({
      readConfigFile: async () => "{ not json",
      readGitRemote: async () => "git@github.com:owner/from-remote.git",
    });
    expect(result).toEqual({ owner: "owner", repo: "from-remote" });
  });

  it("falls through when .claw/config.json has an empty repo string", async () => {
    const result = await detectRepo({
      readConfigFile: async () => '{"repo":""}',
      readGitRemote: async () => "git@github.com:owner/from-remote.git",
    });
    expect(result).toEqual({ owner: "owner", repo: "from-remote" });
  });

  // Source 3 — git remote when config absent
  it("reads repo from the git remote when config.json is absent", async () => {
    const result = await detectRepo({
      readConfigFile: async () => null,
      readGitRemote: async () => "https://github.com/owner/from-remote.git",
    });
    expect(result).toEqual({ owner: "owner", repo: "from-remote" });
  });

  // Source 4 — error when nothing resolves
  it("throws ClawError when no source yields a repo", async () => {
    const error = await detectRepo({
      readConfigFile: async () => null,
      readGitRemote: async () => null,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("could not detect a GitHub repo");
    expect((error as ClawError).hint).toContain("--repo");
  });

  it("throws ClawError when the git remote is not a GitHub URL", async () => {
    const error = await detectRepo({
      readConfigFile: async () => null,
      readGitRemote: async () => "https://gitlab.com/owner/repo.git",
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
  });
});
