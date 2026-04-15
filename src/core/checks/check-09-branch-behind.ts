/**
 * CHECK 9 — no `claw/` branch is behind the default branch.
 *
 * A branch that is behind must be rebased (when no review comments exist yet)
 * or have the default branch merged into it (when comments exist) before the
 * loop can safely continue. The inspector just reports the problem — the
 * recovery action is the orchestrator's job (and lives outside this issue).
 */
import { ClawError } from "../types/errors.js";
import type { CheckResult } from "./types.js";

/**
 * Fail when any `claw/` branch is behind the default branch.
 *
 * @param defaultBranch the default branch name (e.g. `"main"`)
 * @param branchBehind map of `claw/` branch name → commits behind default
 */
export function check09BranchBehind(
  defaultBranch: string,
  branchBehind: Record<string, number>,
): CheckResult {
  // Iterate in sorted key order so the reported offender is deterministic —
  // a GitHub response that happens to return branches in a different order
  // should not change the error message between runs.
  const entries = Object.entries(branchBehind).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [branch, behind] of entries) {
    if (behind > 0) {
      return {
        passed: false,
        error: new ClawError(
          `branch ${branch} is behind ${defaultBranch} by ${behind} commit${behind === 1 ? "" : "s"}.`,
          `Rebase ${branch} onto ${defaultBranch} (or merge ${defaultBranch} in if review comments already exist).`,
        ),
      };
    }
  }
  return { passed: true };
}
