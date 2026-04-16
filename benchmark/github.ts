/**
 * GitHub helpers for the Claw Studio benchmark harness (issue #31).
 *
 * Every function takes an injected Octokit (produced by the core's
 * `createClient()`) so the auth strategy stays owned by one place — the
 * harness never constructs an Octokit itself. The benchmark repo state
 * changes these helpers perform (force-push main, close PRs, delete
 * branches) are narrowly scoped to a single target repo; callers are
 * responsible for passing the right repo.
 */
import { Buffer } from "node:buffer";
import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../src/core/github/repo-detect.js";
import { ClawError } from "../src/core/types/errors.js";
import { ITERATION_PAD, type RunId } from "./types.js";

/**
 * Compute the next iteration label for a given milestone.
 *
 * Labels on the benchmark repo follow the pattern `{milestone}-{NNN}` —
 * for example `v0.1-001`, `v0.1-002`. The next iteration is one greater
 * than the current maximum. When no iteration label exists yet, returns
 * `{milestone}-001`.
 *
 * @param milestone        the product milestone label (e.g. `"v0.1"`)
 * @param existingLabels   every label name currently on the repo
 * @returns a structured {@link RunId} with the next label rendered
 */
export function computeNextRunId(
  milestone: string,
  existingLabels: readonly string[],
): RunId {
  const pattern = new RegExp(`^${escapeRegex(milestone)}-(\\d+)$`);
  let max = 0;
  for (const name of existingLabels) {
    const match = pattern.exec(name);
    if (!match) continue;
    const n = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const iteration = max + 1;
  return {
    milestone,
    iteration,
    label: `${milestone}-${String(iteration).padStart(ITERATION_PAD, "0")}`,
  };
}

/** List every label name on a repo — paginated automatically. */
export async function listLabelNames(
  octokit: Octokit,
  ref: RepoRef,
): Promise<string[]> {
  const rows = await octokit.paginate(octokit.issues.listLabelsForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    per_page: 100,
  });
  return rows.map((row) => row.name);
}

/**
 * Create a new label on the repo. Idempotent on the `name` axis — when
 * the label already exists, the API returns 422 and this helper swallows
 * it so a re-run of the harness does not fall over on the first step.
 *
 * @param color  optional hex without `#`; defaults to a neutral grey
 */
export async function ensureRunLabel(
  octokit: Octokit,
  ref: RepoRef,
  name: string,
  color = "9C9C9C",
): Promise<void> {
  try {
    await octokit.issues.createLabel({
      owner: ref.owner,
      repo: ref.repo,
      name,
      color,
      description: `Claw benchmark iteration ${name}`,
    });
  } catch (err: unknown) {
    if (isAlreadyExists(err)) return;
    throw wrapGitHubError(err, `create label ${name} on ${formatRef(ref)}`);
  }
}

/**
 * Force-push a branch to a specific commit SHA. Used to reset the
 * benchmark repo's `main` to the `initial` tag on every run. This is
 * intentionally destructive — the harness assumes the target repo is
 * expendable, and the issue explicitly calls for it.
 */
export async function forceUpdateBranch(
  octokit: Octokit,
  ref: RepoRef,
  branch: string,
  sha: string,
): Promise<void> {
  try {
    await octokit.git.updateRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${branch}`,
      sha,
      force: true,
    });
  } catch (err: unknown) {
    throw wrapGitHubError(
      err,
      `force-update ${formatRef(ref)}:${branch} to ${shortSha(sha)}`,
    );
  }
}

/** Resolve a git tag (by name) to the commit SHA it points at. */
export async function resolveTagSha(
  octokit: Octokit,
  ref: RepoRef,
  tag: string,
): Promise<string> {
  try {
    const { data } = await octokit.git.getRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `tags/${tag}`,
    });
    // Annotated tags point at a tag object; lightweight tags point straight
    // at a commit. In the annotated case we need one more hop via `getTag`
    // to reach the commit SHA the harness force-pushes to.
    if (data.object.type === "tag") {
      const { data: tagData } = await octokit.git.getTag({
        owner: ref.owner,
        repo: ref.repo,
        tag_sha: data.object.sha,
      });
      return tagData.object.sha;
    }
    return data.object.sha;
  } catch (err: unknown) {
    throw wrapGitHubError(err, `resolve tag ${tag} on ${formatRef(ref)}`);
  }
}

/** A template issue captured from the benchmark repo. */
export interface TemplateIssue {
  /** Template issue number — 1..N in the source repo. */
  number: number;
  /** Title, preserved verbatim when copied. */
  title: string;
  /** Body, preserved verbatim when copied. */
  body: string;
}

/**
 * List every template-labelled issue on the repo — ordered by issue
 * number ascending so the copies land in the order the golden spec
 * expects.
 */
export async function listTemplateIssues(
  octokit: Octokit,
  ref: RepoRef,
  templateLabel = "template",
): Promise<TemplateIssue[]> {
  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    labels: templateLabel,
    state: "all",
    per_page: 100,
  });
  const issues: TemplateIssue[] = rows
    // `listForRepo` also returns PRs; skip them.
    .filter((row) => row.pull_request === undefined)
    .map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
    }));
  issues.sort((a, b) => a.number - b.number);
  return issues;
}

/** Outcome of a {@link copyTemplateIssues} call — one entry per copy. */
export interface CopiedIssue {
  /** New issue number in the target repo. */
  number: number;
  /** Template source rank — matches {@link TemplateIssue.number}. */
  template: number;
  /** Title, for audit-trail display. */
  title: string;
}

/**
 * Copy every template issue onto the repo under the iteration label.
 * The `template` label is NOT carried over — copies are visually
 * distinguishable from the golden source.
 */
export async function copyTemplateIssues(
  octokit: Octokit,
  ref: RepoRef,
  templates: readonly TemplateIssue[],
  iterationLabel: string,
): Promise<CopiedIssue[]> {
  const copies: CopiedIssue[] = [];
  for (const template of templates) {
    try {
      const { data } = await octokit.issues.create({
        owner: ref.owner,
        repo: ref.repo,
        title: template.title,
        body: template.body,
        labels: [iterationLabel],
      });
      copies.push({
        number: data.number,
        template: template.number,
        title: template.title,
      });
    } catch (err: unknown) {
      throw wrapGitHubError(
        err,
        `copy template issue #${template.number} onto ${formatRef(ref)}`,
      );
    }
  }
  return copies;
}

/**
 * Rewrite the `## Current milestone: …` line in the repo's ROADMAP.md to
 * point at the iteration label, and commit the change to `main` via the
 * contents API. Idempotent: when the line already matches, no commit is
 * made.
 *
 * The commit lands directly on `main`. Branch protection on the
 * benchmark repo must allow this — the benchmark is intentionally
 * expendable, and the harness is the sole writer.
 *
 * @returns the new commit SHA, or `null` when no change was needed
 */
export async function updateCurrentMilestoneLine(
  octokit: Octokit,
  ref: RepoRef,
  iterationLabel: string,
  branch = "main",
): Promise<string | null> {
  let current: {
    content: string;
    sha: string;
  };
  try {
    const { data } = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: "ROADMAP.md",
      ref: branch,
    });
    current = decodeFileContent(data);
  } catch (err: unknown) {
    throw wrapGitHubError(
      err,
      `read ROADMAP.md from ${formatRef(ref)}:${branch}`,
    );
  }

  const updated = rewriteCurrentMilestone(current.content, iterationLabel);
  if (updated === current.content) return null;

  try {
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner: ref.owner,
      repo: ref.repo,
      path: "ROADMAP.md",
      message: `benchmark: point current milestone at ${iterationLabel}`,
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: current.sha,
      branch,
    });
    return data.commit.sha ?? null;
  } catch (err: unknown) {
    throw wrapGitHubError(
      err,
      `commit ROADMAP.md update to ${formatRef(ref)}:${branch}`,
    );
  }
}

/**
 * Pure text transform for the ROADMAP.md current-milestone line. Kept
 * separate so tests can assert the regex handles leading whitespace,
 * trailing whitespace, and the `-NNN` suffix pattern without spinning up
 * any network I/O.
 */
export function rewriteCurrentMilestone(
  content: string,
  iterationLabel: string,
): string {
  const line = `## Current milestone: ${iterationLabel}`;
  const pattern = /^##\s+Current\s+milestone:\s+.+$/m;
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  // No existing line — prepend at the top so the loop's roadmap reader
  // still picks it up. A blank line separates it from the original body
  // to preserve the existing structure.
  return `${line}\n\n${content}`;
}

/** Summary of the issue-closure state at one point in time. */
export interface IssueStates {
  /** Count of issues with the iteration label that are still open. */
  open: number;
  /** Count of issues with the iteration label that are closed. */
  closed: number;
  /** Count of closed issues whose last active label was `needs-human`. */
  escalated: number;
}

/**
 * Tally open / closed / escalated issues carrying the iteration label.
 * Used both while polling for loop completion and at run-end to build
 * the final per-issue score.
 */
export async function countIssueStates(
  octokit: Octokit,
  ref: RepoRef,
  iterationLabel: string,
): Promise<IssueStates> {
  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    labels: iterationLabel,
    state: "all",
    per_page: 100,
  });
  let open = 0;
  let closed = 0;
  let escalated = 0;
  for (const row of rows) {
    if (row.pull_request !== undefined) continue;
    if (row.state === "open") {
      open += 1;
    } else {
      closed += 1;
    }
    const labels = row.labels.map(labelName);
    if (labels.includes("needs-human")) escalated += 1;
  }
  return { open, closed, escalated };
}

/** Parallel to {@link countIssueStates} but returning full per-issue rows. */
export async function readIterationIssues(
  octokit: Octokit,
  ref: RepoRef,
  iterationLabel: string,
): Promise<
  Array<{
    number: number;
    title: string;
    state: "open" | "closed";
    labels: string[];
  }>
> {
  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    labels: iterationLabel,
    state: "all",
    per_page: 100,
  });
  return rows
    .filter((row) => row.pull_request === undefined)
    .map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state === "open" ? "open" : "closed",
      labels: row.labels.map(labelName),
    }));
}

/** Close every open PR on the repo — used by the teardown phase. */
export async function closeOpenPullRequests(
  octokit: Octokit,
  ref: RepoRef,
): Promise<number[]> {
  const rows = await octokit.paginate(octokit.pulls.list, {
    owner: ref.owner,
    repo: ref.repo,
    state: "open",
    per_page: 100,
  });
  const closed: number[] = [];
  for (const row of rows) {
    try {
      await octokit.pulls.update({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: row.number,
        state: "closed",
      });
      closed.push(row.number);
    } catch (err: unknown) {
      throw wrapGitHubError(err, `close PR #${row.number} on ${formatRef(ref)}`);
    }
  }
  return closed;
}

/** Close every open issue carrying the iteration label. */
export async function closeIterationIssues(
  octokit: Octokit,
  ref: RepoRef,
  iterationLabel: string,
): Promise<number[]> {
  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    labels: iterationLabel,
    state: "open",
    per_page: 100,
  });
  const closed: number[] = [];
  for (const row of rows) {
    if (row.pull_request !== undefined) continue;
    try {
      await octokit.issues.update({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: row.number,
        state: "closed",
      });
      closed.push(row.number);
    } catch (err: unknown) {
      throw wrapGitHubError(
        err,
        `close issue #${row.number} on ${formatRef(ref)}`,
      );
    }
  }
  return closed;
}

/** Delete every `claw/*` branch. Safety: refuses anything without the prefix. */
export async function deleteClawBranches(
  octokit: Octokit,
  ref: RepoRef,
): Promise<string[]> {
  const rows = await octokit.paginate(octokit.git.listMatchingRefs, {
    owner: ref.owner,
    repo: ref.repo,
    ref: "heads/claw/",
    per_page: 100,
  });
  const deleted: string[] = [];
  for (const row of rows) {
    const branch = row.ref.replace(/^refs\/heads\//, "");
    if (!branch.startsWith("claw/")) {
      // Defence in depth — `listMatchingRefs` already filters by prefix,
      // but a malformed response must not cause us to delete a human
      // branch. See CLAUDE.md "Git rules".
      continue;
    }
    try {
      await octokit.git.deleteRef({
        owner: ref.owner,
        repo: ref.repo,
        ref: `heads/${branch}`,
      });
      deleted.push(branch);
    } catch (err: unknown) {
      throw wrapGitHubError(
        err,
        `delete branch ${branch} on ${formatRef(ref)}`,
      );
    }
  }
  return deleted;
}

/** Post a comment on the tracking issue. Used to record run scores. */
export async function postTrackingComment(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  body: string,
): Promise<number> {
  try {
    const { data } = await octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  } catch (err: unknown) {
    throw wrapGitHubError(
      err,
      `post tracking comment on ${formatRef(ref)}#${issueNumber}`,
    );
  }
}

/**
 * Decode a `repos.getContent` single-file response into UTF-8 text +
 * the file's SHA (needed for the next `createOrUpdateFileContents` call).
 * Mirrors the pattern in `src/core/loop/orchestrator.ts:decodeRoadmap`.
 */
function decodeFileContent(data: unknown): { content: string; sha: string } {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    throw new ClawError(
      "unexpected ROADMAP.md response shape.",
      "Expected a single-file payload — got a directory listing or null.",
    );
  }
  const shape = data as { content?: unknown; encoding?: unknown; sha?: unknown };
  if (typeof shape.content !== "string" || typeof shape.sha !== "string") {
    throw new ClawError(
      "ROADMAP.md had no content / sha.",
      "Re-check that ROADMAP.md is committed to the default branch.",
    );
  }
  const content =
    shape.encoding === "base64"
      ? Buffer.from(shape.content, "base64").toString("utf8")
      : shape.content;
  return { content, sha: shape.sha };
}

/** Normalise a label — Octokit returns either a string or `{ name }`. */
function labelName(label: string | { name?: string | null }): string {
  if (typeof label === "string") return label;
  return label.name ?? "";
}

/** Short-SHA helper for human-readable error messages. */
function shortSha(sha: string): string {
  return sha.length <= 7 ? sha : sha.slice(0, 7);
}

/** Render a {@link RepoRef} as `owner/repo`. */
function formatRef(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** Escape every regex metacharacter in `input` so it matches literally. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when an Octokit error is a 422 "already exists" response. */
function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record["status"] === 422;
}

/**
 * Wrap an Octokit error in a {@link ClawError} with a stable phrasing. Never
 * echoes response bodies (they may contain headers or auth tokens) — only
 * the error's own message, which the SDK already scrubs.
 */
function wrapGitHubError(err: unknown, action: string): ClawError {
  if (err instanceof ClawError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ClawError(
    `could not ${action}.`,
    `Underlying error: ${detail}`,
  );
}
