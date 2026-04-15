/**
 * CHECK 8 — every `claw/` branch has an open PR.
 *
 * The loop always opens the PR as soon as it pushes the first commit. Finding
 * an orphan branch (no PR pointing at it) means a previous run was
 * interrupted between the push and the PR creation call. The human needs to
 * either open a PR manually or delete the branch before the loop can
 * continue.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult, PullRequestSummary } from "./types.js";

/**
 * Fail when a `claw/` branch exists without a matching open PR.
 *
 * @param branches every `claw/` branch on the remote
 * @param pullRequests open PRs (any base, but head refs include claw/ ones)
 */
export function check08BranchNoPr(
  branches: readonly string[],
  pullRequests: readonly PullRequestSummary[],
): CheckResult {
  const prHeads = new Set(pullRequests.map((pr) => pr.headRef));
  const orphan = branches.find((branch) => !prHeads.has(branch));
  if (!orphan) return { passed: true };

  return {
    passed: false,
    error: new ClawError(
      `branch ${orphan} exists but has no open PR.`,
      `Open a PR from ${orphan} against the default branch, or delete the branch.`,
    ),
  };
}
