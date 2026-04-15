/**
 * CHECK 13 — catch-all for states the earlier twelve checks did not cover.
 *
 * This is the inspector's backstop. It runs last, so every named state has
 * already been handled, and flags anomalies that should never happen if
 * checks 1–12 are correct.
 *
 * Current anomalies detected:
 *
 *   - A session file on disk whose issue number does not appear in the
 *     milestone. Sessions are created by the loop against milestone issues,
 *     so a dangling session points to either a deleted / relabeled issue or
 *     a bug in the session lifecycle.
 *   - An open PR whose `linkedIssue` points at an issue the milestone does
 *     not contain. CHECK 7 guarantees a linked issue exists — this one
 *     guarantees the issue is still part of the current milestone.
 */
import { ClawError } from "../types/errors.js";
import type { Issue } from "../roadmap/parser.js";
import type { CheckResult, PullRequestSummary, SessionRecord } from "./types.js";

/**
 * Fail when an anomaly is detected that the earlier checks did not already
 * report. The first anomaly wins — deterministic order keeps the message
 * stable across runs.
 *
 * @param issues every issue in the current milestone
 * @param pullRequests open claw/ pull requests
 * @param sessions session records keyed by issue number
 */
export function check13Unexpected(
  issues: readonly Issue[],
  pullRequests: readonly PullRequestSummary[],
  sessions: Record<number, SessionRecord>,
): CheckResult {
  const milestoneIssueNumbers = new Set(issues.map((issue) => issue.number));

  const orphanSession = Object.values(sessions)
    .slice()
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .find((session) => !milestoneIssueNumbers.has(session.issueNumber));
  if (orphanSession) {
    return {
      passed: false,
      error: new ClawError(
        `session file references issue #${orphanSession.issueNumber}, which is not in the current milestone.`,
        `Remove \`.claw/sessions/${orphanSession.issueNumber}.json\` — the loop has no record of this issue.`,
      ),
    };
  }

  const orphanPr = pullRequests.find(
    (pr) => pr.linkedIssue !== null && !milestoneIssueNumbers.has(pr.linkedIssue),
  );
  if (orphanPr) {
    return {
      passed: false,
      error: new ClawError(
        `PR #${orphanPr.number} links to issue #${orphanPr.linkedIssue ?? 0}, which is not in the current milestone.`,
        "Close the PR, or relabel the linked issue so it belongs to the current milestone.",
      ),
    };
  }

  return { passed: true };
}
