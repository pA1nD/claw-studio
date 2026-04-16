import { readFile } from "node:fs/promises";
import { ClawError } from "../../core/types/errors.js";
import { detectRepo } from "../../core/github/repo-detect.js";
import { resolveSetupPaths } from "../../core/setup/paths.js";
import type { ClawConfig } from "../../core/setup/config.js";
import { startLoop } from "../../core/loop/start-loop.js";
import type { LoopExitResult } from "../../core/loop/start-loop.js";
import type { CycleResult } from "../../core/loop/orchestrator.js";
import { ErrorView } from "../ui/components/Error.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw start` command. */
export interface StartOptions {
  repo?: string;
  autoContinue?: boolean;
  dryRun?: boolean;
}

/**
 * `claw start` — start the loop.
 *
 * Resolves the target repo (via `--repo`, `.claw/config.json`, or git remote),
 * loads the project config, and hands control to {@link startLoop}. The
 * command stays attached for the lifetime of the loop so `claw pause` /
 * `claw stop` (which write control flags) take effect immediately.
 *
 * Exit semantics:
 *   - `halted`             — render the standard error view, exit code 1.
 *   - `stopped`            — render a clean confirmation, exit code 0.
 *   - `milestone-complete` — render a celebratory pause, exit code 0.
 *
 * @param options CLI options (`--repo`, `--auto-continue`, `--dry-run`)
 */
export async function startCommand(options: StartOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  const repoString = `${ref.owner}/${ref.repo}`;

  const config = await loadClawConfig(process.cwd(), repoString);

  const result = await startLoop(config, {
    cwd: process.cwd(),
    autoContinue: options.autoContinue ?? false,
    dryRun: options.dryRun ?? false,
    onCycle: renderCycleLine,
  });

  await renderExit(result, repoString);
}

/**
 * Print one line per cycle while the loop runs. Kept tiny and dependency-free
 * so the dashboard (v0.2+) can replace it without touching the orchestrator.
 *
 * Goes through `process.stdout.write` rather than Ink because Ink's
 * `renderOnce` would mount and unmount React for every line — the loop
 * eventually emits hundreds, so a flat write is the right primitive.
 */
function renderCycleLine(result: CycleResult | { type: "paused" }): void {
  const stamp = new Date().toISOString();
  const line = (() => {
    switch (result.type) {
      case "action-taken":
        return `[${stamp}] ${result.action}`;
      case "waiting":
        return `[${stamp}] waiting — ${result.reason}`;
      case "halted":
        return `[${stamp}] halted — ${result.error.message}`;
      case "milestone-complete":
        return `[${stamp}] milestone ${result.milestone} complete`;
      case "paused":
        return `[${stamp}] paused`;
    }
  })();
  process.stdout.write(`${line}\n`);
}

/** Render the loop exit reason to the terminal and set the exit code. */
async function renderExit(
  result: LoopExitResult,
  repoString: string,
): Promise<void> {
  if (result.type === "halted") {
    await renderOnce(
      <ErrorView
        message={result.error.message}
        hint={result.error.hint}
      />,
    );
    process.exitCode = 1;
    return;
  }
  if (result.type === "milestone-complete") {
    await renderOnce(
      <Success
        message={`milestone ${result.milestone} complete`}
        detail={`${repoString} — update ROADMAP.md to point at the next milestone, then run \`claw start\`.`}
      />,
    );
    return;
  }
  await renderOnce(
    <Success
      message={`stopped — ${repoString}`}
      detail="run `claw start` to resume."
    />,
  );
}

/**
 * Load `.claw/config.json` and return the parsed {@link ClawConfig}.
 *
 * If the file is missing or malformed, halts with a typed error pointing the
 * human at `claw setup`. The fallback to the detected repo string is
 * intentional: setup writes the canonical `repo` field, so reading the
 * resolved value back from disk is a sanity check, not a re-derivation.
 */
async function loadClawConfig(
  cwd: string,
  detectedRepo: string,
): Promise<ClawConfig> {
  const path = resolveSetupPaths(cwd).configJson;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ClawError(
      "no .claw/config.json found.",
      "Run `claw setup` first to initialise this repo for the loop.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClawError(
      ".claw/config.json is not valid JSON.",
      "Re-run `claw setup --overwrite` to regenerate it.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ClawError(
      ".claw/config.json was not a JSON object.",
      "Re-run `claw setup --overwrite` to regenerate it.",
    );
  }
  const shape = parsed as Partial<ClawConfig>;
  const repo = typeof shape.repo === "string" && shape.repo.length > 0
    ? shape.repo
    : detectedRepo;
  const pollInterval =
    typeof shape.pollInterval === "number" && shape.pollInterval > 0
      ? shape.pollInterval
      : 60;
  const clawVersion =
    typeof shape.clawVersion === "string" && shape.clawVersion.length > 0
      ? shape.clawVersion
      : "0.0.1";
  return { repo, pollInterval, clawVersion };
}
