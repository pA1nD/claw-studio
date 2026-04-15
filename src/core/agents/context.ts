import type { Issue } from "../roadmap/parser.js";
import type { PriorReviewNote } from "./prior-review-notes.js";

/** Inputs to {@link buildContextPrompt}. */
export interface ContextPromptInputs {
  /** The issue the agent is about to implement. */
  issue: Issue;
  /** The branch the agent must commit to. */
  branchName: string;
  /** Contents of `README.md` for the target project. */
  readme: string;
  /** Contents of `ROADMAP.md` for the target project. */
  roadmap: string;
  /** Every other issue in the current milestone — open and closed. */
  milestoneIssues: readonly Issue[];
  /** Name of the current milestone (e.g. `"v0.1"`). */
  milestoneName: string;
  /** Prior review notes fetched via {@link fetchPriorReviewNotes}. May be empty. */
  priorReviewNotes: readonly PriorReviewNote[];
}

/** Inputs to {@link buildFixPrompt}. */
export interface FixPromptInputs {
  /** The issue the PR is implementing. */
  issue: Issue;
  /** The PR number under review. */
  prNumber: number;
  /** Full bodies of every blocking review comment, in the order they were posted. */
  reviewComments: readonly ReviewComment[];
  /** How many fix attempts have already been made on this session. */
  attemptNumber: number;
}

/** A single review comment feeding the fix cycle. */
export interface ReviewComment {
  /** Display label (usually the review agent name). */
  author: string;
  /** Full markdown body of the comment. */
  body: string;
}

/**
 * Build the context prompt handed to `claude -p` on the first implementation
 * spawn.
 *
 * The prompt is explicit about:
 *   - the branch the agent must commit to (no ambiguity, no drift);
 *   - the issue it must implement (title, body, full acceptance criteria);
 *   - the project documents (README, ROADMAP) so the agent understands scope;
 *   - sibling issues in the milestone so the agent does not duplicate work;
 *   - prior review notes that explicitly reference this issue — institutional
 *     memory from earlier PRs that the agent would otherwise lose.
 *
 * Exposed as a pure string builder so tests can assert on the prompt contents
 * without touching Claude. Passes through stdin in the runtime path — never
 * on argv — so large README/ROADMAP combinations never trip `ARG_MAX` and
 * never leak into `/proc/[pid]/cmdline`.
 *
 * @param inputs every document the agent needs
 * @returns the full prompt string
 */
export function buildContextPrompt(inputs: ContextPromptInputs): string {
  const siblings = groupSiblingIssues(inputs.issue.number, inputs.milestoneIssues);
  const priorNotes = formatPriorReviewNotes(inputs.priorReviewNotes);

  return [
    "You are the implementation agent for Claw Studio.",
    `Implement GitHub issue #${inputs.issue.number} for milestone ${inputs.milestoneName}.`,
    "",
    `Work on the branch ${inputs.branchName}. Commit every change there.`,
    "When the implementation is complete, push the branch to origin. Do not open the PR yourself — the loop will open it once your subprocess exits.",
    "",
    `--- BEGIN ISSUE #${inputs.issue.number}: ${inputs.issue.title} ---`,
    inputs.issue.body.trim().length === 0 ? "(empty issue body)" : inputs.issue.body.trim(),
    `--- END ISSUE #${inputs.issue.number} ---`,
    "",
    "--- BEGIN README.md ---",
    inputs.readme.trim(),
    "--- END README.md ---",
    "",
    "--- BEGIN ROADMAP.md ---",
    inputs.roadmap.trim(),
    "--- END ROADMAP.md ---",
    "",
    `--- BEGIN MILESTONE ${inputs.milestoneName} ISSUES ---`,
    siblings.done,
    siblings.pending,
    `--- END MILESTONE ${inputs.milestoneName} ISSUES ---`,
    "",
    "--- BEGIN PRIOR REVIEW NOTES ---",
    priorNotes,
    "--- END PRIOR REVIEW NOTES ---",
  ].join("\n");
}

/**
 * Build the fix prompt sent to `claude -p --resume` when reviewers request
 * changes.
 *
 * The rule is strict: fix only what reviewers flagged. Never expand scope,
 * never rewrite untouched code, never introduce unrelated refactors. The
 * prompt includes every blocking comment in full — omitting none — so the
 * agent cannot miss feedback.
 *
 * @param inputs the PR + review comments the agent must address
 * @returns the full prompt string
 */
export function buildFixPrompt(inputs: FixPromptInputs): string {
  const joinedComments = inputs.reviewComments
    .map(
      (c, idx) =>
        `--- COMMENT ${idx + 1} (by ${c.author}) ---\n${c.body.trim()}\n--- END COMMENT ${idx + 1} ---`,
    )
    .join("\n\n");
  return [
    `Review agents requested changes on PR #${inputs.prNumber} (issue #${inputs.issue.number}, fix attempt ${inputs.attemptNumber}).`,
    "Address ONLY the feedback below. Do not expand scope. Do not refactor untouched code.",
    'Commit with `fix: address review feedback` and push to the same branch.',
    "",
    joinedComments,
  ].join("\n");
}

/**
 * Partition the milestone's other issues into a "done" list and a "pending"
 * list, each rendered as a markdown bullet list. Purely formatting.
 */
function groupSiblingIssues(
  currentIssueNumber: number,
  all: readonly Issue[],
): { done: string; pending: string } {
  const others = all.filter((issue) => issue.number !== currentIssueNumber);
  const done = others.filter((issue) => issue.state === "closed");
  const pending = others.filter((issue) => issue.state === "open");
  return {
    done:
      "Closed issues in this milestone (already implemented):\n" +
      (done.length === 0
        ? "(none)"
        : done.map((i) => `- #${i.number} ${i.title}`).join("\n")),
    pending:
      "Open issues in this milestone (still to come):\n" +
      (pending.length === 0
        ? "(none)"
        : pending.map((i) => `- #${i.number} ${i.title}`).join("\n")),
  };
}

/** Format the prior review notes list — returns a stable "(none)" when empty. */
function formatPriorReviewNotes(notes: readonly PriorReviewNote[]): string {
  if (notes.length === 0) return "(none found)";
  return notes
    .map(
      (n) =>
        `From PR #${n.prNumber} (${n.author}, ${n.commentUrl}):\n${n.body.trim()}`,
    )
    .join("\n\n");
}
