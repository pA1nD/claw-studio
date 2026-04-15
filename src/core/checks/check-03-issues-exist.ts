import { ClawError } from "../types/errors.js";
import type { Milestone } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/**
 * CHECK 3 — At least one GitHub issue exists for the current milestone.
 *
 * Counts both open and closed issues, because:
 *   - All-closed is the milestone-complete signal handled by CHECK 4
 *   - Zero-of-anything is "the human hasn't authored issues yet" — different
 *     state, different message
 *
 * Pure function over the {@link Milestone} that CHECK 1+2 produced.
 *
 * @param milestone the resolved milestone (issues already loaded)
 * @returns {@link CheckResult}
 */
export function check03IssuesExist(milestone: Milestone): CheckResult {
  if (milestone.issues.length === 0) {
    return {
      passed: false,
      error: new ClawError(
        `no issues labeled ${milestone.name} found.`,
        `Create GitHub issues labeled ${milestone.name} to continue.`,
      ),
    };
  }
  return { passed: true };
}
