/**
 * CHECK 6 — at most one `claw/` branch exists on the remote.
 *
 * The loop works on one issue at a time. Finding two or more open Claw
 * branches means either a previous run crashed mid-flight, or two operators
 * started the loop simultaneously on the same repo — both need a human to
 * untangle.
 *
 * State 8 of the loop state machine (close all but oldest, treat as the
 * single-PR case) is the repair action, but we report it via a failed check
 * first rather than silently picking a branch.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult } from "./types.js";

/**
 * Fail when more than one `claw/` branch exists on the remote.
 *
 * @param branches every `claw/` branch name the API returned
 */
export function check06MultipleClawBranches(
  branches: readonly string[],
): CheckResult {
  if (branches.length <= 1) return { passed: true };

  // Stable, sorted list so the hint is deterministic across calls — makes it
  // easy to tell a human "yes, this is the same problem as yesterday".
  const sorted = [...branches].sort();
  const list = sorted.join(", ");

  return {
    passed: false,
    error: new ClawError(
      `found ${sorted.length} open claw/ branches: ${list}.`,
      "Close all but the oldest Claw branch — the loop works on one issue at a time.",
    ),
  };
}
