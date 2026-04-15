import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClawError } from "../types/errors.js";
import { resolveSetupPaths } from "../setup/paths.js";
import {
  MAX_FIX_ATTEMPTS,
  extractLinkedIssueNumber,
  isClawPullRequest,
} from "./types.js";
import type { CheckResult, PullRequestInfo, SessionFile } from "./types.js";

/** Dependencies injected into CHECK 11. */
export interface Check11Deps {
  /**
   * Read `.claw/sessions/{N}.json` for an issue. Resolves to `null` when no
   * session file exists (typical case before the implementation agent has
   * touched the issue).
   */
  readSession?: (
    cwd: string,
    issueNumber: number,
  ) => Promise<SessionFile | null>;
}

/**
 * CHECK 11 — No `claw/` PR has burned through {@link MAX_FIX_ATTEMPTS} fix
 * attempts.
 *
 * The implementation agent (issue #3) increments `fixAttempts` in
 * `.claw/sessions/{N}.json` each time it resumes to address review feedback.
 * When the count hits {@link MAX_FIX_ATTEMPTS}, the agent labels the issue
 * `needs-human` and stops. CHECK 11 catches the boundary state — the count
 * is at the limit but the loop has not yet halted on the label.
 *
 * CHECK 5 catches the post-escalation state (label exists). CHECK 11 catches
 * the moment the agent gives up and before the orchestrator picks up the
 * label change. Both must exist; they cover different windows.
 *
 * @param cwd      working directory holding `.claw/sessions/`
 * @param openPRs  every open PR on the repo
 * @param deps     optional injected seam for testing
 * @returns {@link CheckResult} — fails on the first PR over the limit
 */
export async function check11MaxFixAttempts(
  cwd: string,
  openPRs: readonly PullRequestInfo[],
  deps: Check11Deps = {},
): Promise<CheckResult> {
  const readSession = deps.readSession ?? defaultReadSession;

  for (const pr of openPRs) {
    if (!isClawPullRequest(pr)) continue;

    const issueNumber = extractLinkedIssueNumber(pr.body);
    if (issueNumber === null) continue;

    const session = await readSession(cwd, issueNumber);
    if (session === null) continue;
    if (session.fixAttempts < MAX_FIX_ATTEMPTS) continue;

    return {
      passed: false,
      error: new ClawError(
        `PR #${pr.number} has been through ${MAX_FIX_ATTEMPTS} fix attempts and is still blocked.`,
        "Labelled needs-human. Review PR comments and resolve manually.",
      ),
    };
  }
  return { passed: true };
}

/**
 * Default session reader.
 *
 * Returns `null` for any read failure (missing file, bad JSON, wrong shape).
 * The check is read-only — it must not throw on a malformed session file
 * because that is the implementation agent's domain to fix, not the
 * inspector's domain to halt on.
 */
async function defaultReadSession(
  cwd: string,
  issueNumber: number,
): Promise<SessionFile | null> {
  // Sessions live under the canonical `.claw/sessions/` path that setup
  // creates — `resolveSetupPaths` is the single source of truth for layout.
  const path = join(resolveSetupPaths(cwd).sessionsDir, `${issueNumber}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const shape = parsed as Partial<SessionFile>;
  if (typeof shape.issueNumber !== "number") return null;
  if (typeof shape.sessionId !== "string") return null;
  if (typeof shape.fixAttempts !== "number") return null;
  return {
    issueNumber: shape.issueNumber,
    sessionId: shape.sessionId,
    fixAttempts: shape.fixAttempts,
  };
}
