import { ClawError } from "../types/errors.js";
import { hasLinkedIssue, isClawPullRequest } from "./types.js";
import type { CheckResult, PullRequestInfo } from "./types.js";

// Re-exported for callers that already import the helper from this module.
export { hasLinkedIssue };

/**
 * CHECK 7 — Every open `claw/` PR has a linked issue in its body.
 *
 * The loop relies on `Closes #N` to wire each PR back to its source issue —
 * the `get-context` step in `ci.yml` reads it for milestone context, and the
 * orchestrator uses it to know which session belongs to which PR.
 *
 * Only inspects PRs from `claw/` branches: a human-authored PR without a
 * closing keyword is not the loop's concern.
 *
 * @param openPRs every open PR on the repo
 * @returns {@link CheckResult} — fails on the first unlinked claw/ PR
 */
export function check07PRNoIssue(
  openPRs: readonly PullRequestInfo[],
): CheckResult {
  for (const pr of openPRs) {
    if (!isClawPullRequest(pr)) continue;
    if (!hasLinkedIssue(pr.body)) {
      return {
        passed: false,
        error: new ClawError(
          `PR #${pr.number} has no linked issue.`,
          `Add Closes #N to PR #${pr.number}'s body or close the PR.`,
        ),
      };
    }
  }
  return { passed: true };
}
