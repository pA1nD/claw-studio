import { ClawError } from "../types/errors.js";
import type { Issue, Milestone } from "../roadmap/parser.js";
import { extractLinkedIssueNumber, isClawPullRequest } from "./types.js";
import type { CheckResult, PullRequestInfo } from "./types.js";

/**
 * CHECK 13 — Catch-all for unexpected states the earlier checks did not
 * cover.
 *
 * In v0.1 this fires on the one known-unhandled state from the loop's state
 * machine (ROADMAP state 7): an open `claw/` PR whose linked issue has been
 * closed manually. When this happens the loop does not know whether to merge
 * the now-stale PR or close it; halting and asking the human is the only
 * safe action.
 *
 * Other unexpected states (multiple PRs against the same issue, etc.) are
 * caught by CHECKS 6-12 already. Future check additions should be slotted
 * into their own numbered files; CHECK 13 is the catch-all for state we
 * haven't had a chance to formalise yet.
 *
 * @param openPRs   every open PR on the repo
 * @param milestone the resolved milestone (used to look up issue states)
 * @returns {@link CheckResult}
 */
export function check13Unexpected(
  openPRs: readonly PullRequestInfo[],
  milestone: Milestone,
): CheckResult {
  const issuesByNumber = new Map<number, Issue>();
  for (const issue of milestone.issues) {
    issuesByNumber.set(issue.number, issue);
  }

  for (const pr of openPRs) {
    if (!isClawPullRequest(pr)) continue;
    const issueNumber = extractLinkedIssueNumber(pr.body);
    if (issueNumber === null) continue; // CHECK 7 already handled this case.

    const linked = issuesByNumber.get(issueNumber);
    // Issue not in the current milestone is treated as "out of scope" rather
    // than "unexpected" — the inspector cannot reason about issues outside
    // the milestone it was given.
    if (linked === undefined) continue;
    if (linked.state !== "closed") continue;

    return {
      passed: false,
      error: new ClawError(
        `unexpected state: PR #${pr.number} is open but linked issue #${linked.number} is closed.`,
        `Loop paused. Review PR #${pr.number} and either merge or close it, then run claw resume.`,
      ),
    };
  }
  return { passed: true };
}
