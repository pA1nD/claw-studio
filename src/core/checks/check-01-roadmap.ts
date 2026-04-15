/**
 * CHECK 1 — ROADMAP.md exists in the target repo.
 *
 * The loop cannot do anything without a ROADMAP — it's the source of truth
 * for milestone ordering and the set of issues to work on. By the time this
 * check runs inside `inspectRepo`, the ROADMAP has already been loaded via
 * `parseRoadmap` — so this function reaffirms that fact against the
 * pre-loaded state rather than re-fetching from the API.
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult } from "./types.js";

/**
 * Verify a ROADMAP has been resolved.
 *
 * @param roadmapExists whether a ROADMAP.md was read successfully
 * @param repo the `owner/repo` slug used in the failure message
 * @returns a passing {@link CheckResult} when `roadmapExists` is true
 */
export function check01Roadmap(
  roadmapExists: boolean,
  repo: string,
): CheckResult {
  if (roadmapExists) return { passed: true };
  return {
    passed: false,
    error: new ClawError(
      `no ROADMAP.md found in ${repo}.`,
      "Add a ROADMAP.md with at least one milestone to the repo root before the loop can start.",
    ),
  };
}
