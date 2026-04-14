import { describe, it, expect, vi } from "vitest";
import { canAccessRepoVia, runPreflight } from "../../../src/core/setup/preflight.js";
import { resolveRequiredPaths, resolveSetupPaths } from "../../../src/core/setup/paths.js";
import { ClawError } from "../../../src/core/types/errors.js";

const cwd = "/tmp/claw-target";
const ref = { owner: "pA1nD", repo: "claw-studio" };

/** Build a file-exists stub that returns true for the given paths only. */
function existsFor(set: Set<string>): (path: string) => Promise<boolean> {
  return async (path) => set.has(path);
}

describe("runPreflight", () => {
  it("passes when all four checks succeed and overwrite is false", async () => {
    const required = resolveRequiredPaths(cwd);
    const existing = new Set<string>([required.readme, required.roadmap]);

    await expect(
      runPreflight({
        ref,
        cwd,
        overwrite: false,
        deps: {
          canAccessRepo: async () => true,
          fileExists: existsFor(existing),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("CHECK 1 — fails with a PAT hint when the repo is not accessible", async () => {
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => false,
        fileExists: async () => true,
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    const clawError = error as ClawError;
    expect(clawError.message).toContain(`${ref.owner}/${ref.repo}`);
    expect(clawError.hint).toContain("GITHUB_PAT");
  });

  it("CHECK 2 — fails when README.md is missing", async () => {
    const required = resolveRequiredPaths(cwd);
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => true,
        fileExists: existsFor(new Set<string>([required.roadmap])),
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("no README.md");
    expect((error as ClawError).hint).toContain("README.md");
  });

  it("CHECK 3 — fails when ROADMAP.md is missing", async () => {
    const required = resolveRequiredPaths(cwd);
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => true,
        fileExists: existsFor(new Set<string>([required.readme])),
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("no ROADMAP.md");
    expect((error as ClawError).hint).toContain("milestone");
  });

  it("CHECK 4 — fails when .claw/config.json already exists", async () => {
    const required = resolveRequiredPaths(cwd);
    const paths = resolveSetupPaths(cwd);
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => true,
        fileExists: existsFor(
          new Set<string>([required.readme, required.roadmap, paths.configJson]),
        ),
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain(".claw/config.json");
    expect((error as ClawError).hint).toContain("--overwrite");
  });

  it("CHECK 4 — fails when .claw/CLAUDE.md already exists (alone)", async () => {
    // Covers the first candidate in the three-item loop. Without this test,
    // a regression that only iterates the second entry would still pass
    // the config.json test above.
    const required = resolveRequiredPaths(cwd);
    const paths = resolveSetupPaths(cwd);
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => true,
        fileExists: existsFor(
          new Set<string>([required.readme, required.roadmap, paths.claudeMd]),
        ),
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain(".claw/CLAUDE.md");
  });

  it("CHECK 4 — fails when .github/workflows/ci.yml already exists (alone)", async () => {
    // Covers the third candidate — proves the loop reaches the last entry.
    const required = resolveRequiredPaths(cwd);
    const paths = resolveSetupPaths(cwd);
    const error = await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => true,
        fileExists: existsFor(
          new Set<string>([required.readme, required.roadmap, paths.ciYml]),
        ),
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain(".github/workflows/ci.yml");
  });

  it("CHECK 4 — is skipped when overwrite is true", async () => {
    const required = resolveRequiredPaths(cwd);
    const paths = resolveSetupPaths(cwd);
    await expect(
      runPreflight({
        ref,
        cwd,
        overwrite: true,
        deps: {
          canAccessRepo: async () => true,
          fileExists: existsFor(
            new Set<string>([
              required.readme,
              required.roadmap,
              paths.claudeMd,
              paths.configJson,
              paths.ciYml,
            ]),
          ),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("halts on the FIRST failure — does not evaluate later checks", async () => {
    const fileExists = vi.fn(async () => true);
    await runPreflight({
      ref,
      cwd,
      overwrite: false,
      deps: {
        canAccessRepo: async () => false,
        fileExists,
      },
    }).catch(() => undefined);

    // Check 1 fails — checks 2-4 never ran.
    expect(fileExists).not.toHaveBeenCalled();
  });
});

describe("canAccessRepoVia", () => {
  /**
   * Minimal shape of the Octokit subset we pass in, kept in a single place so
   * individual tests don't sprinkle casts around.
   */
  type ReposStub = {
    repos: { get: (args: { owner: string; repo: string }) => Promise<unknown> };
  };
  const asOctokit = (stub: ReposStub): Parameters<typeof canAccessRepoVia>[0] =>
    stub as unknown as Parameters<typeof canAccessRepoVia>[0];

  it("returns true when repos.get succeeds", async () => {
    const check = canAccessRepoVia(
      asOctokit({ repos: { get: vi.fn(async () => ({ data: {} })) } }),
    );
    await expect(check(ref)).resolves.toBe(true);
  });

  it("returns false when repos.get throws", async () => {
    const check = canAccessRepoVia(
      asOctokit({
        repos: {
          get: vi.fn(async () => {
            throw new Error("404");
          }),
        },
      }),
    );
    await expect(check(ref)).resolves.toBe(false);
  });
});
