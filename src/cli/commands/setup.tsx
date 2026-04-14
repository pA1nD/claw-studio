import { detectRepo } from "../../core/github/repo-detect.js";
import { runSetup } from "../../core/setup/index.js";
import type {
  HumanStepContext,
  SetupHooks,
  SetupPlan,
} from "../../core/setup/index.js";
import { Confirm } from "../ui/components/Confirm.js";
import { HumanStep } from "../ui/components/HumanStep.js";
import { Success } from "../ui/components/Success.js";
import { renderInteractive, renderOnce } from "../ui/render.js";

/** Options accepted by the `claw setup` command. */
export interface SetupOptions {
  repo?: string;
  overwrite?: boolean;
}

/**
 * `claw setup` — prepare a GitHub repo to run the Claw Studio loop.
 *
 * Detects the target repo, then hands off to {@link runSetup} to drive the
 * full flow: preflight → confirmation → writes → branch protection →
 * human steps. This command is the thin UI adapter; every decision lives
 * in `src/core/setup/`.
 *
 * @param options CLI options (`--repo`, `--overwrite`)
 * @throws {ClawError} on any failure — surfaced through the standard error view
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });

  const completed = await runSetup({
    ref,
    cwd: process.cwd(),
    overwrite: Boolean(options.overwrite),
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
 * Build the Ink-backed {@link SetupHooks} that drive the interactive parts of
 * the setup flow. Split out so tests can substitute non-interactive hooks.
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
    walkRunnerStep: (context) =>
      renderInteractive<void>((resolve) => (
        <HumanStep
          title="Runners — register at least one self-hosted runner"
          reason="Claw Studio needs a self-hosted runner to fire review agents on every PR."
          url={`${context.repoUrl}/settings/actions/runners/new`}
          details={[
            "Follow the GitHub instructions to register a runner on your machine,",
            "then come back here and press <enter>.",
          ]}
          verify={context.verifyRunnerOnline}
          onDone={() => resolve(undefined)}
        />
      )),
    walkTokenStep: (context) =>
      renderInteractive<void>((resolve) => (
        <HumanStep
          title="Claude token — add CLAUDE_CODE_OAUTH_TOKEN secret"
          reason="Review agents call Claude via this token. Get it from `claude setup-token`."
          url={`${context.repoUrl}/settings/secrets/actions/new`}
          details={[
            "Name the secret exactly `CLAUDE_CODE_OAUTH_TOKEN`.",
            "Paste the token you generated with `claude setup-token`.",
          ]}
          onDone={() => resolve(undefined)}
        />
      )),
  };
}

/** Lines rendered in the confirmation card. */
function buildConfirmLines(plan: SetupPlan): string[] {
  const created = plan.filesToCreate.map((path) => `  ${path}`);
  const checks = plan.requiredChecks.join(", ");
  const lines = ["Will create:", ...created, "", "Will configure:"];
  lines.push(`  Branch protection on the default branch`);
  lines.push(`  Required checks: ${checks}`);
  if (plan.overwrite) {
    lines.push("");
    lines.push("  --overwrite active — existing Claw Studio files will be replaced.");
  }
  return lines;
}

/**
 * Re-exported so tests can build the same hook shape without rendering Ink.
 * The re-export is intentional — `HumanStepContext` is a first-class part
 * of the `claw setup` public surface, not an internal detail.
 */
export type { HumanStepContext, SetupHooks, SetupPlan };
