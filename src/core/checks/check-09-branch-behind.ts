import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";
import { isClawBranch } from "./types.js";
import type { BranchInfo, CheckResult } from "./types.js";

/** How a branch compares to the default branch — only the field we consume. */
export interface BranchComparison {
  /** Number of commits the branch is behind the default. */
  behindBy: number;
}

/** Dependencies injected into CHECK 9. */
export interface Check09Deps {
  /**
   * Compare a branch against the default branch and report how many commits
   * it is behind. Implemented via `repos.compareCommits` by default.
   */
  compareBranchToDefault?: (
    ref: RepoRef,
    defaultBranch: string,
    branchName: string,
  ) => Promise<BranchComparison>;
}

/**
 * CHECK 9 — No `claw/` branch is behind the default branch.
 *
 * Branches that lag main cannot be merged cleanly: the loop's git strategy
 * (issue #6) handles rebase / merge-default before merge, but if a branch is
 * behind by the time the inspector runs, something has skipped that step
 * and the human needs to look.
 *
 * Per-branch network call: GitHub's compare-commits endpoint is the only
 * reliable way to know how far behind a branch is. With at most one in-flight
 * branch (CHECK 6), this is one call per cycle in the common case.
 *
 * @param client        an Octokit client produced by `createClient()`
 * @param ref           the target repository
 * @param defaultBranch default branch name (e.g. `"main"`)
 * @param branches      every branch in the repo
 * @param deps          optional injected seam for testing
 * @returns {@link CheckResult} — fails on the first behind-default claw/ branch
 */
export async function check09BranchBehind(
  client: Octokit,
  ref: RepoRef,
  defaultBranch: string,
  branches: readonly BranchInfo[],
  deps: Check09Deps = {},
): Promise<CheckResult> {
  const compare =
    deps.compareBranchToDefault ?? buildDefaultCompare(client);

  for (const branch of branches) {
    if (!isClawBranch(branch.name)) continue;
    if (branch.name === defaultBranch) continue;

    const result = await compare(ref, defaultBranch, branch.name);
    if (result.behindBy > 0) {
      return {
        passed: false,
        error: new ClawError(
          `branch ${branch.name} is behind ${defaultBranch} by ${result.behindBy} commits.`,
          `Rebase or merge ${defaultBranch} in, then continue.`,
        ),
      };
    }
  }
  return { passed: true };
}

/**
 * Build the default Octokit-backed comparator.
 *
 * `compareCommits` returns a `behind_by` field — the count of commits on the
 * base that aren't on the head. That is exactly the "branch is behind"
 * measurement the loop cares about.
 */
function buildDefaultCompare(
  client: Octokit,
): (
  ref: RepoRef,
  defaultBranch: string,
  branchName: string,
) => Promise<BranchComparison> {
  return async (ref, defaultBranch, branchName) => {
    const { data } = await client.repos.compareCommits({
      owner: ref.owner,
      repo: ref.repo,
      base: defaultBranch,
      head: branchName,
    });
    const behindBy =
      typeof data.behind_by === "number" && data.behind_by >= 0
        ? data.behind_by
        : 0;
    return { behindBy };
  };
}
