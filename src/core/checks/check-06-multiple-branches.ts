import { ClawError } from "../types/errors.js";
import { isClawBranch } from "./types.js";
import type { BranchInfo, CheckResult } from "./types.js";

/**
 * CHECK 6 — At most one open `claw/` branch exists at a time.
 *
 * The loop guarantees a single in-flight issue per cycle. More than one
 * `claw/` branch means either:
 *   - a previous cycle crashed mid-flight and left a branch behind
 *   - a human created a branch with the `claw/` prefix manually
 *   - two loop instances are racing
 *
 * Either way we halt and tell the human exactly which branches we found.
 *
 * Branches are filtered by the `claw/` prefix so human-owned branches never
 * count toward the limit — this is the prefix contract documented in
 * CLAUDE.md.
 *
 * @param branches every branch in the repo (typically from `repos.listBranches`)
 * @returns {@link CheckResult}
 */
export function check06MultipleBranches(
  branches: readonly BranchInfo[],
): CheckResult {
  const clawBranches = branches.filter((branch) => isClawBranch(branch.name));
  if (clawBranches.length <= 1) {
    return { passed: true };
  }
  // Sorting keeps the error message stable across runs — handy for snapshot
  // tests, and one less surprise when the human is debugging.
  const names = clawBranches
    .map((branch) => branch.name)
    .sort()
    .join(", ");
  return {
    passed: false,
    error: new ClawError(
      `found multiple open claw/ branches: ${names}.`,
      "There should be at most one in-flight. Clean up before continuing.",
    ),
  };
}
