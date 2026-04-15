/**
 * CHECK 11 — no open PR has burned through 3 fix attempts.
 *
 * The fix agent gets up to 3 shots at a PR that the reviewers blocked. After
 * that, the issue is escalated (`needs-human` label) and the loop moves on.
 * If the inspector finds a PR still sitting at ≥3 attempts with `CHANGES
 * REQUESTED` still in play, something went wrong with the escalation handoff
 * — we halt and ask the human.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult, PullRequestSummary, SessionRecord } from "./types.js";

/** Maximum fix attempts before the loop escalates. */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Fail when any PR's session has already reached or exceeded
 * {@link MAX_FIX_ATTEMPTS} and reviewers still have changes requested.
 *
 * @param pullRequests open claw/ pull requests
 * @param sessions session records keyed by issue number
 */
export function check11Blocked3Attempts(
  pullRequests: readonly PullRequestSummary[],
  sessions: Record<number, SessionRecord>,
): CheckResult {
  for (const pr of pullRequests) {
    if (pr.linkedIssue === null) continue;
    const session = sessions[pr.linkedIssue];
    if (!session) continue;
    if (session.fixAttempts < MAX_FIX_ATTEMPTS) continue;

    const stillBlocked = pr.reviews.some(
      (review) => review.verdict === "CHANGES REQUESTED",
    );
    if (!stillBlocked) continue;

    return {
      passed: false,
      error: new ClawError(
        `PR #${pr.number} has been through ${session.fixAttempts} fix attempts and is still blocked.`,
        `Add the needs-human label to issue #${pr.linkedIssue}, then delete \`.claw/sessions/${pr.linkedIssue}.json\` so the loop can move on.`,
      ),
    };
  }
  return { passed: true };
}
