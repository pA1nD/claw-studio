/**
 * CHECK 5 — the current issue is not labeled `needs-human`.
 *
 * "Current issue" is the first open issue in the milestone by number. When it
 * carries `needs-human`, something previously escalated and a human has to
 * weigh in before the loop can continue.
 *
 * The loop state machine separately allows skipping `needs-human` issues and
 * moving on to the next one (state 11) — that's the orchestrator's job. This
 * check is the safety net for when the orchestrator would otherwise try to
 * implement an escalated issue.
 */
import { ClawError } from "../types/errors.js";
import type { Issue } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/** Label GitHub carries when the loop has escalated an issue to a human. */
export const NEEDS_HUMAN_LABEL = "needs-human";

/**
 * Fail when the first open issue is labeled `needs-human`.
 *
 * @param issues milestone issues, ordered by number ascending
 */
export function check05CurrentNeedsHuman(issues: readonly Issue[]): CheckResult {
  const current = issues.find((issue) => issue.state === "open");
  if (!current) return { passed: true };

  if (!current.labels.includes(NEEDS_HUMAN_LABEL)) {
    return { passed: true };
  }

  return {
    passed: false,
    error: new ClawError(
      `issue #${current.number} is labeled ${NEEDS_HUMAN_LABEL}.`,
      `Resolve the blockers on issue #${current.number}, remove the ${NEEDS_HUMAN_LABEL} label, and run \`claw status\`.`,
    ),
  };
}
