import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import { withRateLimitHandling } from "../github/rate-limit.js";
import type { Issue } from "../roadmap/parser.js";
import { MAX_FIX_ATTEMPTS, NEEDS_HUMAN_LABEL } from "../checks/types.js";
import { resolveSetupPaths } from "../setup/paths.js";
import { branchName as buildBranchName } from "./branch-name.js";
import { buildContextPrompt, buildFixPrompt } from "./context.js";
import type { ReviewComment } from "./context.js";
import {
  fetchPriorReviewNotes,
  type FetchPriorReviewNotesDeps,
  type PriorReviewNote,
} from "./prior-review-notes.js";
import {
  resumeImplementationSession,
  spawnImplementationSession,
} from "./claude.js";
import type { ClaudeDeps, ClaudeResult } from "./claude.js";
import {
  deleteSession,
  loadSession,
  saveSession,
  type SessionFile,
  type SessionFs,
} from "./session.js";

/** Outcome of a single {@link runImplementationAgent} call. */
export interface ImplementationOutcome {
  /** The branch the agent committed to. */
  branch: string;
  /** The PR the orchestrator opened. */
  prNumber: number;
  /** The session id saved to `.claw/sessions/{issueNumber}.json`. */
  sessionId: string;
}

/** Outcome of a single {@link runFixCycle} call. */
export type FixOutcome =
  | { type: "fixed"; attemptNumber: number; sessionId: string }
  | { type: "escalated"; attemptsMade: number };

/** Dependencies injected into the implementation agent orchestrator. */
export interface ImplementationAgentDeps {
  /** Seams for the `fetchPriorReviewNotes` call. */
  priorReviewNotes?: FetchPriorReviewNotesDeps;
  /** Seams for the `claude -p` subprocess. */
  claude?: ClaudeDeps;
  /** Seams for the session-file read/write/delete. */
  sessionFs?: SessionFs;
  /**
   * Read the target repo's `README.md` contents. Defaults to fetching via
   * Octokit (the same pattern used in `core/roadmap/parser.ts`).
   */
  readRepoFile?: (
    ref: RepoRef,
    path: string,
  ) => Promise<string>;
  /**
   * Open a pull request from `branch` into the default branch with `Closes
   * #{issueNumber}` in the body. Defaults to calling `pulls.create`.
   */
  openPullRequest?: (
    ref: RepoRef,
    args: OpenPullRequestArgs,
  ) => Promise<{ number: number }>;
  /**
   * Apply a label to an issue — used by {@link escalateIssue} to add
   * `needs-human` after the fix budget is exhausted. Defaults to calling
   * `issues.addLabels`.
   */
  addLabel?: (
    ref: RepoRef,
    issueNumber: number,
    label: string,
  ) => Promise<void>;
  /**
   * Post a PR comment — used by {@link escalateIssue} to explain why the
   * agent is handing off. Defaults to calling `issues.createComment`.
   */
  postPRComment?: (
    ref: RepoRef,
    prNumber: number,
    body: string,
  ) => Promise<void>;
}

/** Arguments for the `openPullRequest` seam. */
export interface OpenPullRequestArgs {
  /** Head branch (where the agent committed). */
  headBranch: string;
  /** Base branch (the repo default). */
  baseBranch: string;
  /** PR title — uses the issue title verbatim. */
  title: string;
  /** PR body — always ends with `Closes #{issueNumber}`. */
  body: string;
}

/** Inputs to {@link runImplementationAgent}. */
export interface RunImplementationAgentInputs {
  /** The issue the agent should implement. */
  issue: Issue;
  /** Target project working directory (where `.claw/` lives). */
  cwd: string;
  /** The milestone name (e.g. `"v0.1"`). */
  milestoneName: string;
  /** All other issues in the milestone — feeds the context prompt. */
  milestoneIssues: readonly Issue[];
  /** Target repository (`owner/repo` string). */
  repo: string;
  /** ROADMAP.md contents — passed through to the agent's context. */
  roadmap: string;
  /** Optional injected dependencies for testing. */
  deps?: ImplementationAgentDeps;
}

/** Inputs to {@link runFixCycle}. */
export interface RunFixCycleInputs {
  /** The issue the PR is implementing. */
  issue: Issue;
  /** Target project working directory. */
  cwd: string;
  /** Target repository (`owner/repo` string). */
  repo: string;
  /** The PR number awaiting fixes. */
  prNumber: number;
  /** Every blocking review comment the agent must address. */
  reviewComments: readonly ReviewComment[];
  /** Optional injected dependencies for testing. */
  deps?: ImplementationAgentDeps;
}

/**
 * Run the implementation agent for an issue.
 *
 * Flow:
 *
 *   1. Derive the branch name (`claw/issue-{N}-{slug}`).
 *   2. Fetch prior review notes that reference this issue from merged PRs.
 *   3. Read `README.md` from the target repo.
 *   4. Build the context prompt and spawn `claude -p`. The agent creates the
 *      branch locally, implements the issue, commits, and pushes.
 *   5. Persist `.claw/sessions/{N}.json` with the returned session id and
 *      `fixAttempts: 0`.
 *   6. Open a pull request with `Closes #{N}` in the body.
 *
 * The orchestrator is side-effect-free up to step 4 (Claude's own subprocess
 * owns the filesystem writes). Steps 5-6 are idempotent relative to the
 * session and the PR — a retry is safe as long as the upstream step actually
 * completed.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param inputs the issue + milestone + cwd + deps
 * @returns the PR number, branch name, and persisted session id
 * @throws {ClawError} when Claude fails, the PR cannot be opened, or session save fails
 */
export async function runImplementationAgent(
  client: Octokit,
  inputs: RunImplementationAgentInputs,
): Promise<ImplementationOutcome> {
  const ref = parseRepoString(inputs.repo);
  const deps = inputs.deps ?? {};
  const readRepoFile = deps.readRepoFile ?? buildDefaultReadRepoFile(client);

  const branch = buildBranchName(inputs.issue.number, inputs.issue.title);

  return withRateLimitHandling(async () => {
    const [priorReviewNotes, readme] = await Promise.all([
      fetchPriorReviewNotesSafe(client, ref, inputs.issue.number, deps.priorReviewNotes),
      readRepoFile(ref, "README.md"),
    ]);

    const prompt = buildContextPrompt({
      issue: inputs.issue,
      branchName: branch,
      readme,
      roadmap: inputs.roadmap,
      milestoneIssues: inputs.milestoneIssues,
      milestoneName: inputs.milestoneName,
      priorReviewNotes,
    });

    const paths = resolveSetupPaths(inputs.cwd);
    const claudeResult = await spawnImplementationSession({
      systemPromptPath: paths.claudeMd,
      prompt,
      cwd: inputs.cwd,
      deps: deps.claude,
    });

    const session: SessionFile = {
      issueNumber: inputs.issue.number,
      sessionId: claudeResult.sessionId,
      fixAttempts: 0,
    };
    await saveSession(inputs.cwd, session, deps.sessionFs);

    const defaultBranch = await readDefaultBranch(client, ref);
    const openPR = deps.openPullRequest ?? buildDefaultOpenPullRequest(client);
    const pr = await openPR(ref, {
      headBranch: branch,
      baseBranch: defaultBranch,
      title: inputs.issue.title,
      body: buildPullRequestBody(inputs.issue.number, claudeResult),
    });

    return {
      branch,
      prNumber: pr.number,
      sessionId: claudeResult.sessionId,
    };
  });
}

/**
 * Resume the same Claude session to address review feedback.
 *
 * The orchestrator NEVER spawns a fresh session here — the whole point of the
 * architecture is that the agent that wrote the code is the agent that fixes
 * it. If the session file is missing we must halt rather than silently
 * creating a new one, because a new session means lost context — exactly the
 * drift this design is built to avoid.
 *
 * When `fixAttempts` reaches {@link MAX_FIX_ATTEMPTS} AFTER this attempt, the
 * caller must call {@link escalateIssue} instead of resuming again. That
 * decision lives with the orchestrator (issue #7), not this function.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param inputs the PR number + review comments + cwd + deps
 * @returns whether the fix landed or the agent escalated
 * @throws {ClawError} when the session file is missing or Claude fails
 */
export async function runFixCycle(
  client: Octokit,
  inputs: RunFixCycleInputs,
): Promise<FixOutcome> {
  // Validate the repo string up front so a malformed value halts here
  // rather than deep inside the escalate path where the error is less
  // obviously tied to the caller's input.
  parseRepoString(inputs.repo);
  const deps = inputs.deps ?? {};

  const existing = await loadSession(
    inputs.cwd,
    inputs.issue.number,
    deps.sessionFs,
  );
  if (existing === null) {
    throw new ClawError(
      `no session file for issue #${inputs.issue.number}.`,
      `Expected .claw/sessions/${inputs.issue.number}.json — run \`claw start\` again to spawn a fresh implementation.`,
    );
  }

  return withRateLimitHandling(async () => {
    // Gate BEFORE spending a Claude run. CHECK 11 catches the same threshold
    // but checks in-between cycles — this guard makes `runFixCycle` safe to
    // call directly without re-running the inspector.
    if (existing.fixAttempts >= MAX_FIX_ATTEMPTS) {
      await escalateIssue(client, {
        issue: inputs.issue,
        cwd: inputs.cwd,
        repo: inputs.repo,
        prNumber: inputs.prNumber,
        attemptsMade: existing.fixAttempts,
        reviewComments: inputs.reviewComments,
        deps,
      });
      return { type: "escalated", attemptsMade: existing.fixAttempts };
    }

    const attemptNumber = existing.fixAttempts + 1;
    const prompt = buildFixPrompt({
      issue: inputs.issue,
      prNumber: inputs.prNumber,
      reviewComments: inputs.reviewComments,
      attemptNumber,
    });

    const claudeResult = await resumeImplementationSession({
      sessionId: existing.sessionId,
      prompt,
      cwd: inputs.cwd,
      deps: deps.claude,
    });

    const updated: SessionFile = {
      issueNumber: existing.issueNumber,
      // Resume may return a new session id when Claude forks the history —
      // persist whatever it reported so the next resume still lines up.
      sessionId: claudeResult.sessionId,
      fixAttempts: attemptNumber,
    };
    await saveSession(inputs.cwd, updated, deps.sessionFs);

    if (attemptNumber >= MAX_FIX_ATTEMPTS) {
      await escalateIssue(client, {
        issue: inputs.issue,
        cwd: inputs.cwd,
        repo: inputs.repo,
        prNumber: inputs.prNumber,
        attemptsMade: attemptNumber,
        reviewComments: inputs.reviewComments,
        deps,
      });
      return { type: "escalated", attemptsMade: attemptNumber };
    }

    return { type: "fixed", attemptNumber, sessionId: claudeResult.sessionId };
  });
}

/** Inputs to {@link escalateIssue}. */
export interface EscalateIssueInputs {
  /** The issue being escalated. */
  issue: Issue;
  /** Target project working directory. */
  cwd: string;
  /** Target repository (`owner/repo` string). */
  repo: string;
  /** The PR number the escalation comment is posted to. */
  prNumber: number;
  /** How many fix attempts had been made. */
  attemptsMade: number;
  /** The review comments that blocked the PR — used to compose the escalation note. */
  reviewComments: readonly ReviewComment[];
  /** Optional injected dependencies for testing. */
  deps?: ImplementationAgentDeps;
}

/**
 * Escalate an issue after the fix budget is exhausted.
 *
 * - Label the ISSUE `needs-human` (not the PR — labels on issues surface in
 *   `claw status` via CHECK 5).
 * - Post a comment on the PR summarising what was tried.
 * - Delete the session file so a fresh `claw start` does not try to resume a
 *   stale session.
 *
 * All three operations run sequentially — a failure in any one must surface,
 * because silent failures here leave the loop in an inconsistent state where
 * the inspector would loop forever on a broken PR.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param inputs the issue + PR + attempt context
 */
export async function escalateIssue(
  client: Octokit,
  inputs: EscalateIssueInputs,
): Promise<void> {
  const ref = parseRepoString(inputs.repo);
  const deps = inputs.deps ?? {};
  const addLabel = deps.addLabel ?? buildDefaultAddLabel(client);
  const postComment = deps.postPRComment ?? buildDefaultPostComment(client);

  await withRateLimitHandling(async () => {
    await addLabel(ref, inputs.issue.number, NEEDS_HUMAN_LABEL);
    await postComment(ref, inputs.prNumber, buildEscalationComment(inputs));
  });
  await deleteSession(inputs.cwd, inputs.issue.number, deps.sessionFs);
}

/**
 * Build the PR body used by the implementation agent.
 *
 * Every PR body MUST contain `Closes #{issueNumber}` verbatim — branch
 * protection and CHECK 7 both rely on this. The summary from Claude comes
 * first so reviewers see what the agent did without scrolling.
 *
 * @param issueNumber the issue being closed
 * @param result      the Claude result (may be empty)
 * @returns the PR body string
 */
export function buildPullRequestBody(
  issueNumber: number,
  result: ClaudeResult,
): string {
  const summary = result.resultText.trim();
  const summaryBlock =
    summary.length === 0 ? "(agent reported no summary.)" : summary;
  return `${summaryBlock}\n\nCloses #${issueNumber}\n`;
}

/**
 * Build the escalation comment posted on the PR after the fix budget is
 * exhausted. Explicit about what was tried so the human reviewer does not
 * have to guess at history.
 */
export function buildEscalationComment(inputs: EscalateIssueInputs): string {
  const commentList = inputs.reviewComments
    .map((c) => `- ${c.author}: ${firstLine(c.body)}`)
    .join("\n");
  return [
    "This PR has been handed off for human review.",
    "",
    `The implementation agent attempted ${inputs.attemptsMade} fix cycle${inputs.attemptsMade === 1 ? "" : "s"} after review feedback and was unable to resolve every blocking issue.`,
    "",
    "Blocking review comments at the time of hand-off:",
    commentList.length === 0 ? "- (no review comments captured)" : commentList,
    "",
    `The issue is now labelled \`${NEEDS_HUMAN_LABEL}\`. The loop will skip it until the label is removed.`,
  ].join("\n");
}

/**
 * Wrapper around {@link fetchPriorReviewNotes} that falls back to an empty
 * list if the GitHub call fails.
 *
 * The loop must not halt on "no prior notes" — the notes are a prompt quality
 * improvement, not a correctness requirement. Halting here would surface a
 * transient GitHub issue as a permanent loop blocker, which is worse than
 * temporarily losing the notes on one cycle.
 */
async function fetchPriorReviewNotesSafe(
  client: Octokit,
  ref: RepoRef,
  issueNumber: number,
  deps: FetchPriorReviewNotesDeps | undefined,
): Promise<PriorReviewNote[]> {
  try {
    return await fetchPriorReviewNotes(client, ref, issueNumber, deps);
  } catch {
    return [];
  }
}

/** First non-empty line of `body`, or `"(empty)"`. */
function firstLine(body: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "(empty)";
}

/** Build the default `readRepoFile` seam — reads a file from the repo default branch. */
function buildDefaultReadRepoFile(
  client: Octokit,
): (ref: RepoRef, path: string) => Promise<string> {
  return async (ref, path) => {
    try {
      const { data } = await client.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
      });
      return decodeFileContents(data);
    } catch (err) {
      throw new ClawError(
        `could not read ${path} from ${ref.owner}/${ref.repo}.`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}

/** Decode a single-file response from `repos.getContent`. */
function decodeFileContents(data: unknown): string {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    throw new ClawError(
      "unexpected GitHub contents response.",
      "Expected a single file payload — got a directory listing or null.",
    );
  }
  const shape = data as { content?: unknown; encoding?: unknown };
  if (typeof shape.content !== "string") {
    throw new ClawError(
      "GitHub contents response had no `content` string.",
      "Re-run `claw start` once the target file is readable via the API.",
    );
  }
  if (shape.encoding === "base64") {
    return Buffer.from(shape.content, "base64").toString("utf8");
  }
  return shape.content;
}

/** Build the default `openPullRequest` seam. */
function buildDefaultOpenPullRequest(
  client: Octokit,
): (ref: RepoRef, args: OpenPullRequestArgs) => Promise<{ number: number }> {
  return async (ref, args) => {
    const { data } = await client.pulls.create({
      owner: ref.owner,
      repo: ref.repo,
      head: args.headBranch,
      base: args.baseBranch,
      title: args.title,
      body: args.body,
    });
    return { number: data.number };
  };
}

/** Build the default `addLabel` seam. */
function buildDefaultAddLabel(
  client: Octokit,
): (ref: RepoRef, issueNumber: number, label: string) => Promise<void> {
  return async (ref, issueNumber, label) => {
    await client.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      labels: [label],
    });
  };
}

/** Build the default `postPRComment` seam. */
function buildDefaultPostComment(
  client: Octokit,
): (ref: RepoRef, prNumber: number, body: string) => Promise<void> {
  return async (ref, prNumber, body) => {
    await client.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      body,
    });
  };
}

/** Read the default branch name for a repo. Throws ClawError on an empty repo. */
async function readDefaultBranch(client: Octokit, ref: RepoRef): Promise<string> {
  const { data } = await client.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  });
  if (typeof data.default_branch !== "string" || data.default_branch.length === 0) {
    throw new ClawError(
      `no default branch reported for ${ref.owner}/${ref.repo}.`,
      "Create an initial commit on the repo before running the loop.",
    );
  }
  return data.default_branch;
}
