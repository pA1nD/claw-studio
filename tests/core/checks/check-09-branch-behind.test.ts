import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { check09BranchBehind } from "../../../src/core/checks/check-09-branch-behind.js";
import type { BranchInfo } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const ref = { owner: "pA1nD", repo: "claw-studio" };

function branch(name: string): BranchInfo {
  return { name, sha: "abc" };
}

describe("check09BranchBehind", () => {
  it("passes when the only claw/ branch is up to date", async () => {
    const result = await check09BranchBehind(
      stubClient,
      ref,
      "main",
      [branch("main"), branch("claw/issue-2-x")],
      { compareBranchToDefault: async () => ({ behindBy: 0 }) },
    );
    expect(result.passed).toBe(true);
  });

  it("does not call compare for non-claw branches", async () => {
    const compare = vi.fn(async () => ({ behindBy: 0 }));
    await check09BranchBehind(
      stubClient,
      ref,
      "main",
      [branch("main"), branch("feature/foo")],
      { compareBranchToDefault: compare },
    );
    expect(compare).not.toHaveBeenCalled();
  });

  it("fails with the behind count when a claw/ branch is behind default", async () => {
    const result = await check09BranchBehind(
      stubClient,
      ref,
      "main",
      [branch("claw/issue-2-x")],
      { compareBranchToDefault: async () => ({ behindBy: 4 }) },
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("claw/issue-2-x");
    expect(result.error?.message).toContain("behind main by 4 commits");
    expect(result.error?.hint).toContain("Rebase or merge main in");
  });

  it("halts on the first behind branch — does not check later branches", async () => {
    const compare = vi
      .fn()
      .mockResolvedValueOnce({ behindBy: 2 })
      .mockResolvedValueOnce({ behindBy: 0 });
    await check09BranchBehind(
      stubClient,
      ref,
      "main",
      [branch("claw/issue-2-x"), branch("claw/issue-7-y")],
      { compareBranchToDefault: compare },
    );
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("continues past an up-to-date branch and fails on a later behind one", async () => {
    // Guards against a regression where a misplaced `return { passed: true }`
    // inside the loop short-circuits after the first passing branch.
    const compare = vi
      .fn()
      .mockResolvedValueOnce({ behindBy: 0 })
      .mockResolvedValueOnce({ behindBy: 3 });
    const result = await check09BranchBehind(
      stubClient,
      ref,
      "main",
      [branch("claw/issue-2-x"), branch("claw/issue-7-y")],
      { compareBranchToDefault: compare },
    );
    expect(compare).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("claw/issue-7-y");
    expect(result.error?.message).toContain("behind main by 3 commits");
  });
});
