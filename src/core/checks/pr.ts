/**
 * Small PR helpers that don't belong inside a specific check file.
 *
 * Kept here (rather than duplicated across check files) so changes to the
 * `Closes #N` convention or the review-agent roster land in exactly one place.
 */

/**
 * The canonical list of review agents the v0.1 pipeline expects to see posting
 * verdicts on every PR. Order is the render order used in the summary table
 * and is kept alphabetical-by-role so the list is easy to eyeball.
 *
 * Keep this in strict lockstep with the jobs in `src/core/templates/ci.yml` —
 * mismatched names would cause CHECK 10 to report missing reviews that are
 * actually running under a different label, which is worse than not checking
 * at all.
 */
export const REVIEW_AGENTS: readonly string[] = [
  "Arch",
  "DX",
  "Security",
  "Perf",
  "Test",
];

/** Regex used by {@link extractLinkedIssue}. Exported for testing. */
export const LINKED_ISSUE_REGEX =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i;

/**
 * Extract the issue number a PR closes via its body.
 *
 * Matches the conventions GitHub itself recognises: `close`, `closes`,
 * `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` —
 * case-insensitive, followed by `#N`. Returns `null` when no marker is found.
 *
 * @param body the PR body, or null/empty when GitHub returns no body
 * @returns the referenced issue number, or null
 */
export function extractLinkedIssue(body: string | null | undefined): number | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const match = body.match(LINKED_ISSUE_REGEX);
  if (!match || !match[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse the issue number out of a `claw/issue-{N}-{slug}` branch name.
 *
 * The loop always names branches this way, so branches that do not match the
 * pattern are either old/human branches or otherwise not under the loop's
 * control — CHECK 6 and CHECK 8 already special-case those.
 *
 * @param branch a branch name (with or without the `claw/` prefix)
 * @returns the issue number, or null when the branch is not a Claw branch
 */
export function extractIssueNumberFromBranch(branch: string): number | null {
  const match = branch.match(/^claw\/issue-(\d+)(?:-|$)/);
  if (!match || !match[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
