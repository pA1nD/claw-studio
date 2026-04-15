import { ClawError } from "../types/errors.js";
import type { Milestone } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/**
 * CHECK 4 — Detect milestone-complete: every issue in the milestone is closed.
 *
 * This is **not an error**. It is the happy-path terminal state — the loop
 * has finished its work and is waiting for the human to point it at the next
 * milestone. The inspector marks the result with `terminal: true` so the
 * caller can render a celebratory pause instead of the standard error view.
 *
 * Assumes CHECK 3 already ran (at least one issue exists). With zero issues
 * the "all closed" condition is vacuously true, which would misreport as
 * milestone-complete — CHECK 3 prevents that.
 *
 * @param milestone the resolved milestone (issues already loaded)
 * @returns {@link CheckResult} with `terminal: true` when the milestone is done
 */
export function check04MilestoneComplete(milestone: Milestone): CheckResult {
  const allClosed = milestone.issues.every((issue) => issue.state === "closed");
  if (allClosed) {
    return {
      passed: false,
      terminal: true,
      error: new ClawError(
        `all ${milestone.name} issues are closed.`,
        "Update ROADMAP.md to mark the next milestone as current when ready.",
      ),
    };
  }
  return { passed: true };
}
