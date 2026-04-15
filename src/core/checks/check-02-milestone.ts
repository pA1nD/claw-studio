import { ClawError } from "../types/errors.js";
import { extractCurrentMilestone } from "../roadmap/parser.js";
import type { CheckResult } from "./types.js";

/**
 * CHECK 2 — `## Current milestone:` is marked in `ROADMAP.md`.
 *
 * Pure function: no GitHub calls, no filesystem. Takes the roadmap content
 * loaded by CHECK 1 and extracts the milestone name. Reuses
 * {@link extractCurrentMilestone} from the roadmap parser so the matching
 * rules stay in lockstep — there is one definition of "what counts as a
 * current-milestone heading" and CHECK 2 honours it.
 */
export type Check02Result =
  | { passed: true; milestoneName: string }
  | (Extract<CheckResult, { passed: false }>);

/**
 * Run CHECK 2 against `ROADMAP.md` content.
 *
 * @param roadmapContent the raw ROADMAP.md body (typically from CHECK 1)
 * @returns {@link Check02Result} — `passed: true` carries the milestone name
 */
export function check02Milestone(roadmapContent: string): Check02Result {
  const name = extractCurrentMilestone(roadmapContent);
  if (name === null) {
    return {
      passed: false,
      error: new ClawError(
        "no current milestone in ROADMAP.md.",
        "Add a line near the top: ## Current milestone: vX.X",
      ),
    };
  }
  return { passed: true, milestoneName: name };
}
