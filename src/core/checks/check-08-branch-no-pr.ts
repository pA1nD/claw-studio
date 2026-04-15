import { ClawError } from "../types/errors.js";
import { isClawBranch } from "./types.js";
import type { BranchInfo, CheckResult, PullRequestInfo } from "./types.js";

/**
 * CHECK 8 — Every `claw/` branch has an open PR pointing at it.
 *
 * Detects "ghost branches" — leftovers from a crashed cycle that opened a
 * branch but never opened the PR, or PRs that were closed without deleting
 * the branch. The loop cannot recover from a branch with no PR because
 * there is nowhere to post review verdicts.
 *
 * Comparison is by branch name vs PR head ref. Both are unprefixed (no
 * `refs/heads/`) so a straight equality check is enough.
 *
 * @param branches every branch in the repo
 * @param openPRs  every open PR on the repo
 * @returns {@link CheckResult} — fails on the first orphaned claw/ branch
 */
export function check08BranchNoPR(
  branches: readonly BranchInfo[],
  openPRs: readonly PullRequestInfo[],
): CheckResult {
  const headRefs = new Set(openPRs.map((pr) => pr.headRef));
  for (const branch of branches) {
    if (!isClawBranch(branch.name)) continue;
    if (!headRefs.has(branch.name)) {
      return {
        passed: false,
        error: new ClawError(
          `branch ${branch.name} exists but has no open PR.`,
          `Open a PR from ${branch.name} or delete the branch.`,
        ),
      };
    }
  }
  return { passed: true };
}
