/**
 * Branch-name helpers re-exported from the canonical `core/git/` home.
 *
 * The implementation lives in `core/git/branch-name.ts` because branch-name
 * construction is a git concern and CLAUDE.md designates `core/git/` as the
 * single owner of all git operations. This file exists so the implementation
 * agent (issue #3) and its tests can continue importing from
 * `core/agents/branch-name.js` without churn — both paths resolve to the same
 * implementation.
 */
export {
  BRANCH_SLUG_MAX_LENGTH,
  branchName,
  slugify,
} from "../git/branch-name.js";
