/**
 * CHECK 10 — every open PR has a verdict from every review agent.
 *
 * The merge gate depends on all 5 agents posting. A missing verdict means
 * either the review workflow failed to run or one of the agents crashed —
 * either way, the loop can't decide whether to merge or fix, so it halts.
 *
 * PENDING (the agent ran but hasn't posted yet) is treated as "not missing"
 * here — state 3 of the state machine covers waiting for pending reviews.
 * Only agents with zero evidence of running are reported as missing.
 */
import { ClawError } from "../types/errors.js";
import { REVIEW_AGENTS } from "./pr.js";
import type { CheckResult, PullRequestSummary } from "./types.js";

/**
 * Fail when any open PR is missing a review from one of the expected agents.
 *
 * @param pullRequests open claw/ pull requests
 */
export function check10MissingReviews(
  pullRequests: readonly PullRequestSummary[],
): CheckResult {
  for (const pr of pullRequests) {
    const present = new Set(pr.reviews.map((r) => r.agent));
    const missing = REVIEW_AGENTS.filter((agent) => !present.has(agent));
    if (missing.length > 0) {
      return {
        passed: false,
        error: new ClawError(
          `PR #${pr.number} is missing reviews from: ${missing.join(", ")}.`,
          `Re-run the failed review jobs on PR #${pr.number} or check the self-hosted runners are online.`,
        ),
      };
    }
  }
  return { passed: true };
}
