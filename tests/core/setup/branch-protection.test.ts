import { describe, it, expect, vi } from "vitest";
import {
  configureBranchProtection,
  REQUIRED_STATUS_CHECKS,
} from "../../../src/core/setup/branch-protection.js";
import { ClawError } from "../../../src/core/types/errors.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };

type Repos = Parameters<typeof configureBranchProtection>[0]["octokit"]["repos"];

/** Build a minimal repos stub. */
function reposStub(overrides: Partial<Repos>): {
  octokit: { repos: Repos };
} {
  const repos = {
    get: vi.fn(async () => ({ data: { default_branch: "main" } })),
    updateBranchProtection: vi.fn(async () => ({ data: {} })),
    ...overrides,
  } as unknown as Repos;
  return { octokit: { repos } };
}

describe("configureBranchProtection", () => {
  it("sets protection on the default branch with the required checks", async () => {
    const update = vi.fn(async () => ({ data: {} }));
    const { octokit } = reposStub({
      updateBranchProtection: update as unknown as Repos["updateBranchProtection"],
    });

    await configureBranchProtection({ ref, octokit });

    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    expect(args?.["owner"]).toBe(ref.owner);
    expect(args?.["repo"]).toBe(ref.repo);
    expect(args?.["branch"]).toBe("main");
    expect(args?.["enforce_admins"]).toBe(true);
    expect(args?.["allow_force_pushes"]).toBe(false);
    expect(args?.["allow_deletions"]).toBe(false);
    const checks = args?.["required_status_checks"] as
      | { strict: boolean; contexts: readonly string[] }
      | undefined;
    expect(checks?.strict).toBe(true);
    expect(checks?.contexts).toEqual([...REQUIRED_STATUS_CHECKS]);
  });

  it("respects an explicit branch override", async () => {
    const update = vi.fn(async () => ({ data: {} }));
    const { octokit } = reposStub({
      updateBranchProtection: update as unknown as Repos["updateBranchProtection"],
    });

    await configureBranchProtection({ ref, octokit, branch: "trunk" });

    const args = update.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.["branch"]).toBe("trunk");
  });

  it("throws ClawError when the default branch cannot be read", async () => {
    const { octokit } = reposStub({
      get: vi.fn(async () => {
        throw new Error("401");
      }) as unknown as Repos["get"],
    });

    const error = await configureBranchProtection({ ref, octokit }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("repo metadata");
  });

  it("throws ClawError when repo metadata has no default branch", async () => {
    const { octokit } = reposStub({
      get: vi.fn(async () => ({ data: { default_branch: "" } })) as unknown as Repos["get"],
    });

    const error = await configureBranchProtection({ ref, octokit }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("no default branch");
  });

  it("throws ClawError when updateBranchProtection fails", async () => {
    const { octokit } = reposStub({
      updateBranchProtection: vi.fn(async () => {
        throw new Error("403 Forbidden");
      }) as unknown as Repos["updateBranchProtection"],
    });

    const error = await configureBranchProtection({ ref, octokit }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).hint).toContain("admin access");
  });
});

describe("REQUIRED_STATUS_CHECKS", () => {
  it("matches the exact names of the required jobs in ci.yml", () => {
    expect(REQUIRED_STATUS_CHECKS).toEqual([
      "Lint",
      "Type Check",
      "Tests",
      "Review Summary",
    ]);
  });
});
