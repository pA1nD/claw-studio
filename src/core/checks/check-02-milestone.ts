/**
 * CHECK 2 — a current milestone is marked in ROADMAP.md.
 *
 * `parseRoadmap` extracts the first token after `## Current milestone:`. When
 * the line is missing entirely, the parser throws before this check runs.
 * Here we only need to defend against a milestone that was parsed but ended
 * up with an empty / whitespace-only name — which can happen if the heading
 * line is `## Current milestone:  ` with no token after the colon.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult } from "./types.js";

/**
 * Verify the milestone name is non-empty.
 *
 * @param milestoneName the value of `milestone.name`, or `null` if not parsed
 * @returns a passing {@link CheckResult} when a usable name is present
 */
export function check02Milestone(milestoneName: string | null): CheckResult {
  if (typeof milestoneName === "string" && milestoneName.trim().length > 0) {
    return { passed: true };
  }
  return {
    passed: false,
    error: new ClawError(
      "no current milestone in ROADMAP.md.",
      "Add a line near the top: ## Current milestone: vX.X",
    ),
  };
}
