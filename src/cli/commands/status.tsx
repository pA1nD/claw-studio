import { detectRepo } from "../../core/github/repo-detect.js";
import { createClient } from "../../core/github/client.js";
import { parseRoadmap } from "../../core/roadmap/parser.js";
import { buildRepoState } from "../../core/checks/state.js";
import { runChecks } from "../../core/checks/inspector.js";
import { ClawError } from "../../core/types/errors.js";
import { StatusReport } from "../ui/components/StatusReport.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw status` command. */
export interface StatusOptions {
  repo?: string;
}

/**
 * `claw status` — run every inspector check and render the result.
 *
 * Ordered flow:
 *   1. Resolve the target repo via the standard detection chain
 *   2. Parse ROADMAP.md (covers CHECK 1 + CHECK 2 at the source)
 *   3. Build the read-only {@link RepoState} snapshot once
 *   4. Run `runChecks` — executes CHECKS 1–13 in order
 *   5. On a passing result, render a summary; on failure, raise the
 *      underlying {@link ClawError} so the shared error view fires
 *
 * This command never starts the loop. It is purely read-only and safe to run
 * at any time — CLAUDE.md and the issue both call this out explicitly.
 */
export async function statusCommand(options: StatusOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  const client = createClient();
  const repoSlug = `${ref.owner}/${ref.repo}`;
  const milestone = await parseRoadmap(client, repoSlug);

  const state = await buildRepoState({
    client,
    ref,
    milestone,
    cwd: process.cwd(),
  });
  const result = runChecks(state);

  if (!result.passed) {
    // Surface through the CLI's typed-error pipeline so the standard
    // `[CLAW] Stopped — …` view is rendered. Terminal results take the
    // same path in v0.1 — differentiated only by the message copy.
    throw result.error ?? new ClawError("unknown check failure.");
  }

  const openIssues = milestone.issues.filter((issue) => issue.state === "open").length;
  await renderOnce(
    <StatusReport
      repo={repoSlug}
      milestone={milestone.name}
      totalIssues={milestone.issues.length}
      openIssues={openIssues}
      openPullRequests={state.openPullRequests.length}
    />,
  );
}
