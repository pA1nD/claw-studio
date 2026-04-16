import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { createClient } from "../github/client.js";
import type { ClawConfig } from "../setup/config.js";
import {
  defaultControlFs,
  isPaused,
  isStopped,
  clearStopFlag,
  type ControlFs,
} from "./control.js";
import { appendLog } from "./log.js";
import type { LogFs } from "./log.js";
import { runCycle } from "./orchestrator.js";
import type { CycleResult, OrchestratorDeps } from "./orchestrator.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  IDLE_WARNING_MS,
  PAUSE_POLL_MS,
} from "./orchestrator.js";

/**
 * The discriminated outcome of a {@link startLoop} run — what the caller renders
 * to the human after the loop exits.
 */
export type LoopExitResult =
  | { type: "halted"; error: ClawError }
  | { type: "stopped" }
  | { type: "milestone-complete"; milestone: string };

/** Options accepted by {@link startLoop}. */
export interface StartLoopOptions {
  /** Working directory of the target project (where `.claw/` lives). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Roll into the next milestone without prompting on completion. */
  autoContinue?: boolean;
  /**
   * Skip the cycle action and report what it would have done. Routed through
   * {@link runCycle}'s `dryRun` switch — implementation deferred to a future
   * milestone; for v0.1 this flag forces the loop to exit after a single
   * inspector pass so the human can preview the next action via the log.
   */
  dryRun?: boolean;
  /** Optional Octokit client (defaults to {@link createClient}). */
  client?: Octokit;
  /** Optional dependency seams forwarded to {@link runCycle}. */
  deps?: OrchestratorDeps;
  /** Optional control-flag filesystem seam (defaults to disk). */
  controlFs?: ControlFs;
  /** Optional log filesystem seam (defaults to disk). */
  logFs?: LogFs;
  /** Subscribe to every cycle outcome — used by the dashboard / Ink renderer. */
  onCycle?: (result: CycleResult | { type: "paused" }) => void;
  /** Sleep helper — defaults to `setTimeout`. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Time source for idle detection — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run the loop continuously until paused, stopped, halted, or the milestone
 * completes.
 *
 * Behaviour:
 *
 *   - On entry: clear any stale `stop` flag so a previous run's signal does
 *     not immediately terminate the new loop.
 *   - Each iteration: check `stop` → exit; check `pause` → wait + retry; run
 *     a cycle; log the outcome; sleep `pollInterval` seconds; repeat.
 *   - A `halted` cycle exits the loop with the error (the human resolves
 *     manually, then `claw resume`).
 *   - A `milestone-complete` cycle exits unless `autoContinue` is set — in
 *     which case the loop keeps polling and a future ROADMAP update will
 *     point it at the next milestone.
 *   - Idle detection: if no `action-taken` cycle fires within
 *     {@link IDLE_WARNING_MS}, the loop appends a warning line to the log
 *     (visible via `claw logs`).
 *
 * @param config the parsed `.claw/config.json`
 * @param options overrides for cwd, control flags, logging, and seams
 * @returns the exit reason — never throws
 */
export async function startLoop(
  config: ClawConfig,
  options: StartLoopOptions = {},
): Promise<LoopExitResult> {
  const cwd = options.cwd ?? process.cwd();
  const client = options.client ?? createClient();
  const controlFs = options.controlFs ?? defaultControlFs;
  const logFs = options.logFs;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = pollIntervalMs(config);

  // Clear any stale stop flag from a previous run. Pause is intentionally
  // preserved — if the human paused before starting, they likely want it
  // honoured immediately.
  await clearStopFlag(cwd, controlFs);

  let lastActionAt = now();
  let idleWarningEmitted = false;

  // `for (;;)` instead of `while (true)` — same semantics but avoids
  // ESLint's `no-constant-condition` rule. The loop only ever exits via the
  // explicit `return` statements below.
  for (;;) {
    if (await isStopped(cwd, controlFs)) {
      return { type: "stopped" };
    }

    if (await isPaused(cwd, controlFs)) {
      options.onCycle?.({ type: "paused" });
      await sleep(PAUSE_POLL_MS);
      continue;
    }

    const result = await runCycle(client, config, {
      cwd,
      deps: options.deps,
      sleep,
    });
    options.onCycle?.(result);
    await safeAppendLog(cwd, formatCycle(result), logFs);

    if (result.type === "action-taken") {
      lastActionAt = now();
      idleWarningEmitted = false;
    }

    if (result.type === "halted") {
      return { type: "halted", error: result.error };
    }
    if (result.type === "milestone-complete") {
      if (!options.autoContinue) {
        return { type: "milestone-complete", milestone: result.milestone };
      }
      // Auto-continue: the loop keeps polling. A future ROADMAP edit (or a
      // human flipping the milestone label) will give the next cycle real
      // work.
    }

    if (options.dryRun === true) {
      // Dry-run: a single cycle is enough to preview the next action; exit
      // cleanly so the human can read the log.
      return { type: "stopped" };
    }

    if (
      !idleWarningEmitted &&
      now() - lastActionAt > IDLE_WARNING_MS
    ) {
      idleWarningEmitted = true;
      await safeAppendLog(
        cwd,
        `WARNING idle for ${Math.floor(IDLE_WARNING_MS / 60_000)}m — no state change`,
        logFs,
      );
    }

    await sleep(pollMs);
  }
}

/** Format a cycle outcome as a single log line. */
export function formatCycle(result: CycleResult | { type: "paused" }): string {
  switch (result.type) {
    case "action-taken":
      return `ACTION ${result.action}`;
    case "waiting":
      return `WAIT ${result.reason}`;
    case "halted":
      // Only the message — never the full error — is logged. The hint goes
      // to the renderer, not the log file. See {@link toClawError}.
      return `HALT ${result.error.message}`;
    case "milestone-complete":
      return `MILESTONE_COMPLETE ${result.milestone}`;
    case "paused":
      return "PAUSED waiting for resume";
  }
}

/** Convert the config's poll interval (seconds) to milliseconds. */
function pollIntervalMs(config: ClawConfig): number {
  const seconds =
    typeof config.pollInterval === "number" && config.pollInterval > 0
      ? config.pollInterval
      : DEFAULT_POLL_INTERVAL_SECONDS;
  return seconds * 1_000;
}

/** Default sleep — `setTimeout` Promise wrapper. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Append to the loop log without ever propagating a logging failure.
 *
 * The loop's correctness must not depend on disk health: a full filesystem,
 * a permissions issue, or a race with `claw logs` should never crash a cycle.
 * Logging is best-effort by design.
 */
async function safeAppendLog(
  cwd: string,
  line: string,
  fs: LogFs | undefined,
): Promise<void> {
  try {
    if (fs === undefined) {
      await appendLog(cwd, line);
    } else {
      await appendLog(cwd, line, fs);
    }
  } catch {
    // Intentionally swallow — never let a log failure break the loop.
  }
}
