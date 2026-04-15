import { ClawError } from "../types/errors.js";
import type { Issue, Milestone } from "../roadmap/parser.js";
import { NEEDS_HUMAN_LABEL, extractLinkedIssueNumber } from "./types.js";
import type { CheckResult, PullRequestInfo } from "./types.js";

/**
 * CHECK 5 — The lowest-numbered open issue in the milestone is labeled
 * `needs-human`.
 *
 * The "current" issue is whichever open issue the loop would pick up next:
 * the lowest-numbered one. If that issue is `needs-human` the loop is stuck
 * and the human has to either remove the label or close the linked PR.
 *
 * The check also surfaces the PR number that triggered the escalation when it
 * can be found, so the error message points the human directly at the PR
 * thread instead of asking them to dig through the issue.
 *
 * @param milestone    the resolved milestone (issues already loaded)
 * @param openPRs      every open PR on the repo — used to locate the linked PR
 * @returns {@link CheckResult}
 */
export function check05NeedsHuman(
  milestone: Milestone,
  openPRs: readonly PullRequestInfo[],
): CheckResult {
  const current = findLowestOpenIssue(milestone.issues);
  if (current === null) {
    // No open issues at all — CHECK 4 should have already reported this state.
    // We don't second-guess it here.
    return { passed: true };
  }

  if (!current.labels.includes(NEEDS_HUMAN_LABEL)) {
    return { passed: true };
  }

  const linked = findLinkedPR(current.number, openPRs);
  const hint = linked
    ? `Review PR #${linked.number} and resolve manually, then remove the ${NEEDS_HUMAN_LABEL} label.`
    : `Resolve issue #${current.number} manually, then remove the ${NEEDS_HUMAN_LABEL} label.`;

  return {
    passed: false,
    error: new ClawError(
      `issue #${current.number} is labeled ${NEEDS_HUMAN_LABEL} after 3 failed fix attempts.`,
      hint,
    ),
  };
}

/** The open issue with the smallest issue number, or null when none exist. */
function findLowestOpenIssue(issues: readonly Issue[]): Issue | null {
  let lowest: Issue | null = null;
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    if (lowest === null || issue.number < lowest.number) {
      lowest = issue;
    }
  }
  return lowest;
}

/**
 * Find the open PR that links to a given issue via `Closes #N` (or one of the
 * other GitHub-recognised closing keywords) in its body.
 *
 * Returns the first match — there should never be more than one open PR per
 * issue, but if there is, CHECK 8 / CHECK 13 will catch it.
 */
function findLinkedPR(
  issueNumber: number,
  openPRs: readonly PullRequestInfo[],
): PullRequestInfo | null {
  return (
    openPRs.find((pr) => extractLinkedIssueNumber(pr.body) === issueNumber) ??
    null
  );
}
