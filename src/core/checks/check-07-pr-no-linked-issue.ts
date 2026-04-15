/**
 * CHECK 7 — every open Claw PR references a GitHub issue.
 *
 * The loop opens every PR with `Closes #N` in the body so merging the PR
 * closes the backing issue atomically. A PR without a linked issue cannot be
 * routed back to a roadmap entry — the loop halts and asks the human.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult, PullRequestSummary } from "./types.js";

/**
 * Fail when any open PR is missing a `Closes #N` marker.
 *
 * @param pullRequests open claw/ pull requests
 */
export function check07PrNoLinkedIssue(
  pullRequests: readonly PullRequestSummary[],
): CheckResult {
  const offender = pullRequests.find((pr) => pr.linkedIssue === null);
  if (!offender) return { passed: true };

  return {
    passed: false,
    error: new ClawError(
      `PR #${offender.number} has no linked issue.`,
      `Add "Closes #N" to the body of PR #${offender.number}, or close the PR.`,
    ),
  };
}
