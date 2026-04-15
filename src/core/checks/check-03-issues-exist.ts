/**
 * CHECK 3 — issues exist for the current milestone.
 *
 * An empty milestone means either nothing has been planned yet, or the label
 * name in ROADMAP.md does not match the GitHub label. Either way, the loop
 * has no work to do until a human fixes it — we halt rather than silently
 * idle.
 */
import { ClawError } from "../types/errors.js";
import type { Issue } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/**
 * Fail when the milestone has zero issues (open or closed).
 *
 * @param milestoneName the label being inspected, used in the failure message
 * @param issues every issue that carries the milestone label
 */
export function check03IssuesExist(
  milestoneName: string,
  issues: readonly Issue[],
): CheckResult {
  if (issues.length > 0) return { passed: true };
  return {
    passed: false,
    error: new ClawError(
      `no issues labeled ${milestoneName} found.`,
      `Create at least one GitHub issue with the ${milestoneName} label, or fix the milestone name in ROADMAP.md.`,
    ),
  };
}
