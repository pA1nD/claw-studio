/**
 * CHECK 12 — no open PR has a failing CI check.
 *
 * A red check is a hard halt in v0.1: the fix agent's job is review-comment
 * feedback, not arbitrary CI failures. A human needs to look. In-flight
 * checks (`conclusion === null`) are ignored — they might still turn green.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult, PullRequestSummary, StatusCheckSummary } from "./types.js";

/**
 * Conclusion strings GitHub reports as "definitely failed". Anything else
 * (success, neutral, skipped, queued, in_progress, or null) is not a halt
 * condition — we only stop the loop on unambiguous failure.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/**
 * Fail when any open PR has one or more CI checks in a failing state.
 *
 * @param pullRequests open claw/ pull requests
 */
export function check12CiFailing(
  pullRequests: readonly PullRequestSummary[],
): CheckResult {
  for (const pr of pullRequests) {
    const failing = pr.statusChecks.filter(isFailingCheck).map((c) => c.name);
    if (failing.length > 0) {
      return {
        passed: false,
        error: new ClawError(
          `CI is failing on PR #${pr.number}: ${failing.join(", ")}.`,
          `Look at the failing jobs on PR #${pr.number} and fix the underlying problem.`,
        ),
      };
    }
  }
  return { passed: true };
}

/** True when a status check has reached a definitely-failed terminal state. */
function isFailingCheck(check: StatusCheckSummary): boolean {
  return check.conclusion !== null && FAILING_CONCLUSIONS.has(check.conclusion);
}
