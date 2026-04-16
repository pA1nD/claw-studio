import { CLAW_BRANCH_PREFIX } from "../checks/types.js";

/**
 * Maximum number of characters taken from the title for the branch slug.
 *
 * Branch names are visible in PR URLs, GitHub UIs, and on the command line —
 * 40 is long enough to convey intent, short enough to stay readable.
 */
export const BRANCH_SLUG_MAX_LENGTH = 40;

/**
 * Derive a deterministic branch name for an issue.
 *
 * Format: `claw/issue-{N}-{slug}` — the `claw/` prefix keeps the loop from
 * ever touching a human branch (see CLAUDE.md "Git rules"), and the issue
 * number makes it trivial to link a branch back to its issue.
 *
 * The slug is derived from the issue title:
 *   - Lowercased.
 *   - Non-alphanumeric runs collapsed into single hyphens.
 *   - Leading/trailing hyphens stripped.
 *   - Truncated to {@link BRANCH_SLUG_MAX_LENGTH} characters (then stripped again).
 *   - Empty slugs — e.g. issues titled "???" — fall back to `"issue"` so the
 *     branch still has a readable suffix.
 *
 * Canonical home for branch-name construction. The `core/agents/` module
 * re-exports this for backwards compatibility with the implementation agent
 * (issue #3) that seeded the helper — `core/git/` owns "all git operations"
 * per CLAUDE.md, and branch naming is a git concern, so this module is the
 * single source of truth.
 *
 * @param issueNumber GitHub issue number (must be positive)
 * @param title       issue title
 * @returns the branch name
 */
export function branchName(issueNumber: number, title: string): string {
  return `${CLAW_BRANCH_PREFIX}issue-${issueNumber}-${slugify(title)}`;
}

/**
 * Convert an arbitrary string to the slug form used by {@link branchName}.
 *
 * Exposed separately so tests can verify the slug rules directly and the loop
 * can reuse the exact same transformation elsewhere (e.g. when mapping an
 * existing branch back to its issue).
 *
 * @param input the raw string (typically a GitHub issue title)
 * @returns a slug that is safe to embed in a git branch name
 */
export function slugify(input: string): string {
  const collapsed = input
    .toLowerCase()
    // Replace any non-alphanumeric run (including multiple punctuation chars
    // in a row) with a single hyphen so "foo -- bar" and "foo_bar" produce
    // the same slug shape.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (collapsed.length === 0) return "issue";

  const truncated = collapsed.slice(0, BRANCH_SLUG_MAX_LENGTH);
  // Truncation may have cut mid-word and left a trailing hyphen — strip it
  // so `claw/issue-12-foo-` never ships.
  return truncated.replace(/-+$/g, "");
}
