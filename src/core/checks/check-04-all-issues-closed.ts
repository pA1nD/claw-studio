/**
 * CHECK 4 — not every milestone issue is already closed.
 *
 * This is a *terminal* check: if every issue is closed, the milestone is done
 * and the loop should pause-and-notify rather than surface an error. It runs
 * after CHECK 3 so we know the issues array is non-empty.
 */
import { ClawError } from "../types/errors.js";
import type { Issue } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/**
 * Signal milestone completion when every issue is closed.
 *
 * @param milestoneName current milestone name, used in the friendly message
 * @param issues every issue that carries the milestone label (non-empty)
 * @returns a `terminal` failure when all issues are closed; pass otherwise
 */
export function check04AllIssuesClosed(
  milestoneName: string,
  issues: readonly Issue[],
): CheckResult {
  // If CHECK 3 passed, `issues` is non-empty. We still guard here so this
  // function is safe to call on its own — defensive rather than expensive.
  if (issues.length === 0) return { passed: true };

  const anyOpen = issues.some((issue) => issue.state === "open");
  if (anyOpen) return { passed: true };

  return {
    passed: false,
    terminal: true,
    error: new ClawError(
      `every ${milestoneName} issue is closed — milestone complete.`,
      `Update ROADMAP.md to mark the next milestone when you're ready to continue.`,
    ),
  };
}
