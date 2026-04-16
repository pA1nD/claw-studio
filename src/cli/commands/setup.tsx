import { detectRepo } from "../../core/github/repo-detect.js";
import { runSetup } from "../../core/setup/index.js";
import type { SetupHooks, SetupPlan } from "../../core/setup/index.js";
import { Confirm } from "../ui/components/Confirm.js";
import { Success } from "../ui/components/Success.js";
import { renderInteractive, renderOnce } from "../ui/render.js";

/** Options accepted by the `claw setup` command. */
export interface SetupOptions {
  repo?: string;
  overwrite?: boolean;
  yes?: boolean;
  skipRunners?: boolean;
  runnerCount?: number;
  githubPat?: string;
  claudeToken?: string;
}

/**
 * `claw setup` — prepare a GitHub repo to run the Claw Studio loop.
 *
 * Detects the target repo, then hands off to {@link runSetup} to drive the
 * full headless flow: preflight → resolve tokens → confirmation (unless
 * `--yes`) → writes → branch protection → push Actions secret → start
 * Docker runners (unless `--skip-runners`). This command is the thin UI
 * adapter; every decision lives in `src/core/setup/`.
 *
 * @param options CLI options (`--repo`, `--overwrite`, `--yes`, `--skip-runners`,
 *                `--runner-count`, `--github-pat`, `--claude-token`)
 * @throws {ClawError} on any failure — surfaced through the standard error view
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });

  const completed = await runSetup({
    ref,
    cwd: process.cwd(),
    overwrite: Boolean(options.overwrite),
    yes: Boolean(options.yes),
    skipRunners: Boolean(options.skipRunners),
    runnerCount: options.runnerCount,
    tokens: {
      githubPat: options.githubPat,
      claudeToken: options.claudeToken,
    },
    hooks: buildInkHooks(),
  });

  if (!completed) {
    await renderOnce(
      <Success
        message={`setup aborted — ${ref.owner}/${ref.repo}`}
        detail="no files were written. Re-run `claw setup` when you're ready."
      />,
    );
    return;
  }

  await renderOnce(
    <Success
      message={`setup complete — ${ref.owner}/${ref.repo}`}
      detail="Run `claw status` to confirm everything is green, then `claw start`."
    />,
  );
}

/**
 * Build the Ink-backed {@link SetupHooks} for the setup flow.
 *
 * `claw setup` is headless by default — the runner registration and secret
 * injection that used to require browser steps now happen via the GitHub
 * API. The only remaining interactive step is the confirmation, which
 * `--yes` removes entirely.
 */
export function buildInkHooks(): SetupHooks {
  return {
    confirm: (plan) =>
      renderInteractive<boolean>((resolve) => (
        <Confirm
          title={`Setting up Claw Studio on ${plan.ref.owner}/${plan.ref.repo}`}
          lines={buildConfirmLines(plan)}
          onAnswer={resolve}
        />
      )),
  };
}

/** Lines rendered in the confirmation card. */
function buildConfirmLines(plan: SetupPlan): string[] {
  const created = plan.filesToCreate.map((path) => `  ${path}`);
  const checks = plan.requiredChecks.join(", ");
  const lines = ["Will create:", ...created, "", "Will configure:"];
  lines.push("  Branch protection on the default branch");
  lines.push(`  Required checks: ${checks}`);
  lines.push("  CLAUDE_CODE_OAUTH_TOKEN pushed as a repo Actions secret");
  if (plan.skipRunners) {
    lines.push("  (runners skipped — --skip-runners active)");
  } else {
    lines.push(`  ${plan.runnerCount} Docker-backed self-hosted runners`);
  }
  if (plan.overwrite) {
    lines.push("");
    lines.push("  --overwrite active — existing Claw Studio files will be replaced.");
  }
  return lines;
}

/**
 * Re-exported so tests can build the same hook shape without rendering Ink.
 */
export type { SetupHooks, SetupPlan };
