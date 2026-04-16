/**
 * End-to-end benchmark harness for Claw Studio (issue #31).
 *
 * Drives the full lifecycle against a purpose-built benchmark project
 * (`pA1nD/claw-e2e-mdcast` by default) and scores the result:
 *
 *     1. Setup     — mint iteration label, reset main, copy template
 *                    issues, point ROADMAP at the iteration
 *     2. Run       — spawn `claw setup` then `claw start` in the
 *                    benchmark workspace
 *     3. Monitor   — poll issue states until the milestone is complete
 *                    or the wall-clock timeout elapses
 *     4. Evaluate  — run `npm test` on final main, compute four scores +
 *                    composite via `./evaluate.ts`
 *     5. Record    — write JSON to `~/.claw-bench/results/{runId}.json`,
 *                    optionally post a tracking-issue comment
 *     6. Teardown  — close open PRs, close iteration issues, delete
 *                    every `claw/*` branch, force-push main to the
 *                    initial tag
 *
 * Every GitHub call flows through an Octokit built by the core's
 * `createClient()` — the harness never constructs one itself. Every
 * shell invocation uses `execa` so cancellation surfaces cleanly.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execa, type ExecaChildProcess } from "execa";
import type { Octokit } from "@octokit/rest";
import { Command } from "commander";

import { createClient } from "../src/core/github/client.js";
import { parseRepoString } from "../src/core/github/repo-detect.js";
import type { RepoRef } from "../src/core/github/repo-detect.js";
import { ClawError, isClawError } from "../src/core/types/errors.js";
import { parseSession } from "../src/core/agents/session.js";

import {
  evaluate,
  formatTrackingComment,
  parseTestOutput,
  totalEscalations,
  totalFixCycles,
} from "./evaluate.js";
import {
  closeIterationIssues,
  closeOpenPullRequests,
  computeNextRunId,
  copyTemplateIssues,
  countIssueStates,
  deleteClawBranches,
  ensureRunLabel,
  forceUpdateBranch,
  listLabelNames,
  listTemplateIssues,
  postTrackingComment,
  readIterationIssues,
  resolveTagSha,
  updateCurrentMilestoneLine,
  type CopiedIssue,
} from "./github.js";
import type { IssueResult, RunId, RunResult, TestTotals } from "./types.js";

/** Default benchmark repo — the purpose-built mdcast project. */
export const DEFAULT_REPO = "pA1nD/claw-e2e-mdcast";

/** Default milestone label — v0.1, matching the only milestone mdcast implements. */
export const DEFAULT_MILESTONE = "v0.1";

/** Default initial-state tag the harness force-pushes main back to. */
export const DEFAULT_INITIAL_TAG = "initial";

/** Default wall-clock timeout for the full loop — 2 hours per the issue. */
export const DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;

/** Default polling interval while monitoring the loop — 30 seconds. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;

/** Root directory for the harness's persistent state (`~/.claw-bench/`). */
export function defaultBenchRoot(): string {
  return join(homedir(), ".claw-bench");
}

/** Fully-resolved harness options — every field has a concrete value. */
export interface HarnessOptions {
  /** Target repository (defaults to {@link DEFAULT_REPO}). */
  repo: string;
  /** Milestone label (defaults to {@link DEFAULT_MILESTONE}). */
  milestone: string;
  /** Initial-state tag to reset main to (defaults to {@link DEFAULT_INITIAL_TAG}). */
  initialTag: string;
  /** Wall-clock timeout in seconds. */
  timeoutSeconds: number;
  /** Poll interval in seconds while monitoring the loop. */
  pollIntervalSeconds: number;
  /** Optional tracking-issue number to post scores on. */
  trackingIssue: number | null;
  /** `~/.claw-bench/` root (defaults to {@link defaultBenchRoot}). */
  benchRoot: string;
  /**
   * Optional: stop after the setup phase without actually spawning
   * `claw`. Useful for smoke-testing the harness itself.
   */
  dryRun: boolean;
  /** The `claw` binary to invoke (defaults to `claw` on PATH). */
  clawBin: string;
}

/** CLI-facing options — every field is optional, filled in by {@link resolveOptions}. */
export interface HarnessCliOptions {
  repo?: string;
  milestone?: string;
  initialTag?: string;
  timeout?: number;
  pollInterval?: number;
  trackingIssue?: number;
  benchRoot?: string;
  dryRun?: boolean;
  clawBin?: string;
}

/** Injected dependencies — the harness accepts an Octokit + shell/fs seams for tests. */
export interface HarnessDeps {
  /** Octokit factory — defaults to {@link createClient}. */
  makeOctokit?: () => Octokit;
  /** Shell runner — defaults to {@link execa}. */
  shell?: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<ShellResult>;
  /** Background shell runner — returns a handle that can be killed. */
  spawn?: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => SpawnHandle;
  /** Sleep helper — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Time source — defaults to `Date.now`. */
  now?: () => number;
  /** Session-file reader — defaults to scanning `.claw/sessions/`. */
  readSessionFiles?: (cwd: string) => Promise<SessionSnapshot[]>;
  /** Diagnostic logger — defaults to {@link defaultLogger} (stderr). */
  logger?: HarnessLogger;
}

/**
 * Diagnostic logger for the harness. `info` and `warn` are routed to
 * the same stream by the default implementation so a tail on stderr
 * captures every status line.
 */
export interface HarnessLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

/** One-shot shell command result. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Background spawn handle — the harness kills this when the loop ends. */
export interface SpawnHandle {
  /** Wait for the process to exit. */
  exit: Promise<ShellResult>;
  /** Send SIGTERM; used at teardown. */
  kill: (signal?: NodeJS.Signals) => void;
}

/** Point-in-time snapshot of a single `.claw/sessions/{N}.json` file. */
export interface SessionSnapshot {
  issueNumber: number;
  fixAttempts: number;
}

/**
 * Run the benchmark end-to-end. Returns the completed {@link RunResult}
 * so callers that want to chain runs (a nightly regression sweep, a
 * CI job) can inspect the scores without re-reading the JSON.
 */
export async function runBenchmark(
  options: HarnessOptions,
  deps: HarnessDeps = {},
): Promise<RunResult> {
  const shell = deps.shell ?? defaultShell;
  const spawn = deps.spawn ?? defaultSpawn;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readSessions = deps.readSessionFiles ?? readSessionFilesFromDisk;
  const log = deps.logger ?? defaultLogger();
  const octokit = (deps.makeOctokit ?? createClient)();

  const ref = parseRepoString(options.repo);

  // ── 1. Setup ─────────────────────────────────────────────────────────
  log.info(`[bench] starting run on ${options.repo}`);
  const runId = await mintRunId(octokit, ref, options.milestone);
  log.info(`[bench] minted run id ${runId.label}`);
  await ensureRunLabel(octokit, ref, runId.label);

  const initialSha = await resolveTagSha(octokit, ref, options.initialTag);
  log.info(`[bench] resetting main to tag ${options.initialTag} (${initialSha.slice(0, 7)})`);
  await forceUpdateBranch(octokit, ref, "main", initialSha);

  const templates = await listTemplateIssues(octokit, ref);
  if (templates.length === 0) {
    throw new ClawError(
      `no template-labelled issues found on ${options.repo}.`,
      "The benchmark repo must have at least one issue labelled `template`.",
    );
  }
  log.info(`[bench] copying ${templates.length} template issues under ${runId.label}`);
  const copies = await copyTemplateIssues(octokit, ref, templates, runId.label);

  log.info(`[bench] pointing ROADMAP.md at ${runId.label}`);
  await updateCurrentMilestoneLine(octokit, ref, runId.label);

  const workspace = await ensureWorkspace(
    options.benchRoot,
    ref,
    { shell },
  );

  if (options.dryRun) {
    log.info(`[bench] --dry-run: setup complete, not spawning claw`);
    return await buildDryRunResult(runId, options.repo, copies);
  }

  // ── 2. Run + 3. Monitor ─────────────────────────────────────────────
  const startedAt = now();
  const onError = async (action: string, err: unknown): Promise<never> => {
    log.error(`[bench] ${action} failed: ${formatError(err)}`);
    await safeTeardown(octokit, ref, options, runId.label, initialSha, log);
    throw err;
  };

  try {
    log.info(`[bench] running \`${options.clawBin} setup\` in ${workspace}`);
    await shell(
      options.clawBin,
      ["setup", "--repo", options.repo, "--overwrite", "--yes"],
      { cwd: workspace },
    );
  } catch (err) {
    return await onError("claw setup", err);
  }

  log.info(`[bench] spawning \`${options.clawBin} start\` in the background`);
  const loop = spawn(
    options.clawBin,
    ["start", "--repo", options.repo, "--auto-continue"],
    { cwd: workspace },
  );

  let loopOutcome: ShellResult | null = null;
  loop.exit.then(
    (result) => {
      loopOutcome = result;
    },
    (err) => {
      log.error(`[bench] loop exited with error: ${formatError(err)}`);
    },
  );

  try {
    await monitorLoop({
      octokit,
      ref,
      iterationLabel: runId.label,
      timeoutMs: options.timeoutSeconds * 1_000,
      pollIntervalMs: options.pollIntervalSeconds * 1_000,
      startedAt,
      now,
      sleep,
      isLoopDone: () => loopOutcome !== null,
      logger: log,
    });
  } finally {
    loop.kill("SIGTERM");
  }

  const durationSeconds = Math.round((now() - startedAt) / 1_000);

  // ── 4. Evaluate ─────────────────────────────────────────────────────
  log.info(`[bench] evaluating run ${runId.label}`);
  const issueRows = await readIterationIssues(octokit, ref, runId.label);
  const sessionSnapshots = await readSessions(workspace);
  const issues = buildIssueResults(copies, issueRows, sessionSnapshots);

  const testTotals = await runTests(workspace, shell, log);
  const scores = evaluate({ issues, tests: testTotals });
  const result: RunResult = {
    runId: runId.label,
    timestamp: new Date(now()).toISOString(),
    repo: options.repo,
    durationSeconds,
    scores,
    issues,
  };

  // ── 5. Record ───────────────────────────────────────────────────────
  await recordResult(options.benchRoot, result);
  if (options.trackingIssue !== null) {
    await postTrackingComment(
      octokit,
      ref,
      options.trackingIssue,
      formatTrackingComment(result, {
        fixCycles: totalFixCycles(issues),
        escalations: totalEscalations(issues),
      }),
    );
  }

  // ── 6. Teardown ─────────────────────────────────────────────────────
  await safeTeardown(octokit, ref, options, runId.label, initialSha, log);

  log.info(
    `[bench] done ${runId.label} — composite ${scores.composite.toFixed(2)} ` +
      `(completion ${scores.completion.toFixed(2)}, correctness ${scores.correctness.toFixed(2)}, ` +
      `efficiency ${scores.efficiency.toFixed(2)}, autonomy ${scores.autonomy.toFixed(2)})`,
  );

  return result;
}

/**
 * Compute the next iteration label by reading every label currently on
 * the repo. Pure glue between `listLabelNames` and `computeNextRunId`.
 */
export async function mintRunId(
  octokit: Octokit,
  ref: RepoRef,
  milestone: string,
): Promise<RunId> {
  const existing = await listLabelNames(octokit, ref);
  return computeNextRunId(milestone, existing);
}

/**
 * Merge {@link HarnessCliOptions} onto the hardcoded defaults so the CLI
 * can accept partial input. The result is always a complete
 * {@link HarnessOptions} — no downstream code has to re-check optional
 * fields.
 */
export function resolveOptions(cli: HarnessCliOptions = {}): HarnessOptions {
  return {
    repo: cli.repo ?? DEFAULT_REPO,
    milestone: cli.milestone ?? DEFAULT_MILESTONE,
    initialTag: cli.initialTag ?? DEFAULT_INITIAL_TAG,
    timeoutSeconds: cli.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    pollIntervalSeconds: cli.pollInterval ?? DEFAULT_POLL_INTERVAL_SECONDS,
    trackingIssue: cli.trackingIssue ?? null,
    benchRoot: cli.benchRoot ?? defaultBenchRoot(),
    dryRun: cli.dryRun ?? false,
    clawBin: cli.clawBin ?? "claw",
  };
}

/**
 * Monitor the loop until either every iteration issue is closed or the
 * wall-clock timeout elapses. Exported so tests can exercise the polling
 * shape directly.
 */
export interface MonitorLoopOptions {
  octokit: Octokit;
  ref: RepoRef;
  iterationLabel: string;
  timeoutMs: number;
  pollIntervalMs: number;
  startedAt: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** True when the spawned loop has already exited (pulled from the bg handle). */
  isLoopDone: () => boolean;
  /** Optional logger — falls back to {@link defaultLogger}. */
  logger?: HarnessLogger;
}

export async function monitorLoop(options: MonitorLoopOptions): Promise<void> {
  const log = options.logger ?? defaultLogger();
  const deadline = options.startedAt + options.timeoutMs;
  let lastOpen = Number.POSITIVE_INFINITY;

  while (options.now() < deadline) {
    const states = await countIssueStates(
      options.octokit,
      options.ref,
      options.iterationLabel,
    );
    if (states.open !== lastOpen) {
      log.info(
        `[bench] progress — open ${states.open}, closed ${states.closed}, escalated ${states.escalated}`,
      );
      lastOpen = states.open;
    }

    // Completion condition: no open issues left (every one is either
    // merged, closed manually, or escalated to needs-human).
    if (states.open === 0 && states.closed > 0) {
      log.info(`[bench] every iteration issue has closed — exiting monitor`);
      return;
    }

    // Secondary exit: the spawned loop process has exited on its own
    // (milestone-complete pause, a halt, or a crash). Grace-period one
    // more poll so any in-flight merges register.
    if (options.isLoopDone()) {
      log.info(`[bench] loop process exited — final poll then exit`);
      await options.sleep(options.pollIntervalMs);
      return;
    }

    await options.sleep(options.pollIntervalMs);
  }

  log.warn(
    `[bench] wall-clock timeout (${Math.round(options.timeoutMs / 1_000)}s) elapsed — scoring partial state`,
  );
}

/**
 * Build per-issue scoring rows by zipping template copies against the
 * final issue state + session fix-attempt counters.
 *
 * A copy is "merged" when the GitHub issue is closed AND does not
 * carry the `needs-human` label. Fix-cycle counts come from the loop's
 * session files — when a session file is missing (successful merge
 * deletes it), fix cycles default to 0.
 */
export function buildIssueResults(
  copies: readonly CopiedIssue[],
  rows: ReadonlyArray<{ number: number; labels: string[]; state: "open" | "closed" }>,
  sessions: readonly SessionSnapshot[],
): IssueResult[] {
  const rowByNumber = new Map(rows.map((row) => [row.number, row]));
  const sessionByNumber = new Map(
    sessions.map((snap) => [snap.issueNumber, snap]),
  );
  return copies.map((copy) => {
    const row = rowByNumber.get(copy.number);
    const escalated = row?.labels.includes("needs-human") ?? false;
    const closed = row?.state === "closed";
    const merged = closed && !escalated;
    const session = sessionByNumber.get(copy.number);
    return {
      number: copy.number,
      template: copy.template,
      title: copy.title,
      merged,
      escalated,
      fixCycles: session?.fixAttempts ?? 0,
    };
  });
}

/**
 * Clone the benchmark repo into `{benchRoot}/repos/{repo}` (idempotent).
 * If the workspace already exists, `git fetch` + reset to `origin/main`
 * so the harness starts from a clean slate without losing the persisted
 * `.claw/.env` from a previous run.
 */
export async function ensureWorkspace(
  benchRoot: string,
  ref: RepoRef,
  deps: { shell: HarnessDeps["shell"] },
): Promise<string> {
  const reposDir = join(benchRoot, "repos");
  await mkdir(reposDir, { recursive: true });
  const target = join(reposDir, ref.repo);
  const shell = deps.shell ?? defaultShell;

  let cloned = false;
  try {
    await readFile(join(target, ".git", "HEAD"), "utf8");
  } catch {
    cloned = true;
  }

  if (cloned) {
    await shell(
      "git",
      [
        "clone",
        `https://github.com/${ref.owner}/${ref.repo}.git`,
        target,
      ],
      { cwd: reposDir },
    );
  } else {
    await shell("git", ["fetch", "origin", "--prune"], { cwd: target });
    await shell("git", ["checkout", "main"], { cwd: target });
    await shell("git", ["reset", "--hard", "origin/main"], { cwd: target });
  }
  return target;
}

/**
 * Read every `.claw/sessions/*.json` file in `cwd` and return one
 * snapshot per issue. A successful merge deletes the session file — so
 * the snapshot set represents only issues that escalated or are still
 * in flight at scoring time.
 */
export async function readSessionFilesFromDisk(
  cwd: string,
): Promise<SessionSnapshot[]> {
  const dir = join(cwd, ".claw", "sessions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const snapshots: SessionSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf8");
      const parsed = parseSession(raw);
      if (parsed === null) continue;
      snapshots.push({
        issueNumber: parsed.issueNumber,
        fixAttempts: parsed.fixAttempts,
      });
    } catch {
      // Unreadable file = skip. Scoring is best-effort on sessions.
    }
  }
  return snapshots;
}

/**
 * Run `npm install && npm test` in `cwd` and parse the result. On any
 * failure to run, returns `{ total: 0, passing: 0 }` so the evaluator
 * reports a correctness score of 0 per the issue's contract.
 */
export async function runTests(
  cwd: string,
  shell: NonNullable<HarnessDeps["shell"]>,
  logger?: HarnessLogger,
): Promise<TestTotals> {
  const log = logger ?? defaultLogger();
  try {
    await shell("npm", ["install"], { cwd });
  } catch (err) {
    log.warn(`[bench] npm install failed: ${formatError(err)}`);
    return { total: 0, passing: 0 };
  }

  let raw = "";
  try {
    const result = await shell("npm", ["test"], { cwd });
    raw = `${result.stdout}\n${result.stderr}`;
  } catch (err) {
    // `npm test` exit code ≠ 0 still gives us output to parse — execa
    // bundles stdout/stderr onto the thrown error when `all: true`, but
    // the default path leaves them on the error object too.
    if (isShellFailure(err)) {
      raw = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    } else {
      log.warn(`[bench] npm test failed to run: ${formatError(err)}`);
      return { total: 0, passing: 0 };
    }
  }

  const parsed = parseTestOutput(raw);
  if (parsed === null) {
    log.warn(`[bench] could not parse npm test output — scoring correctness as 0`);
    return { total: 0, passing: 0 };
  }
  return parsed;
}

/**
 * Write the run result to `{benchRoot}/results/{runId}.json`. Creates
 * the results directory on first run.
 */
export async function recordResult(
  benchRoot: string,
  result: RunResult,
): Promise<string> {
  const dir = join(benchRoot, "results");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${result.runId}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Close every open PR, close every iteration issue, delete every
 * `claw/*` branch, and force-push main back to the initial tag. Every
 * step is wrapped — a failure in one does not stop the others.
 */
async function safeTeardown(
  octokit: Octokit,
  ref: RepoRef,
  options: HarnessOptions,
  iterationLabel: string,
  initialSha: string,
  log: HarnessLogger,
): Promise<void> {
  log.info(`[bench] teardown: closing PRs, closing iteration issues, pruning branches`);
  await runOrLog(log, `close open PRs`, async () => {
    const closed = await closeOpenPullRequests(octokit, ref);
    if (closed.length > 0) log.info(`[bench] closed PRs: ${closed.join(", ")}`);
  });
  await runOrLog(log, `close iteration issues (${iterationLabel})`, async () => {
    const closed = await closeIterationIssues(octokit, ref, iterationLabel);
    if (closed.length > 0) log.info(`[bench] closed issues: ${closed.join(", ")}`);
  });
  await runOrLog(log, `prune claw/* branches`, async () => {
    const deleted = await deleteClawBranches(octokit, ref);
    if (deleted.length > 0) log.info(`[bench] deleted branches: ${deleted.join(", ")}`);
  });
  await runOrLog(log, `reset main to ${options.initialTag}`, async () => {
    await forceUpdateBranch(octokit, ref, "main", initialSha);
  });
}

/** Run a teardown step, logging a failure instead of propagating. */
async function runOrLog(
  log: HarnessLogger,
  action: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`[bench] teardown step "${action}" failed: ${formatError(err)}`);
  }
}

/** Build the result shape used for `--dry-run`: zero scores, zero tests. */
async function buildDryRunResult(
  runId: RunId,
  repo: string,
  copies: readonly CopiedIssue[],
): Promise<RunResult> {
  const issues: IssueResult[] = copies.map((copy) => ({
    number: copy.number,
    template: copy.template,
    title: copy.title,
    merged: false,
    escalated: false,
    fixCycles: 0,
  }));
  const scores = evaluate({ issues, tests: { total: 0, passing: 0 } });
  return {
    runId: runId.label,
    timestamp: new Date().toISOString(),
    repo,
    durationSeconds: 0,
    scores,
    issues,
  };
}

/** Format any thrown value into a single short string for logs. */
function formatError(err: unknown): string {
  if (isClawError(err)) {
    return err.hint ? `${err.message} — ${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Type guard for execa-style errors that carry `stdout` / `stderr`. */
function isShellFailure(err: unknown): err is { stdout?: string; stderr?: string } {
  if (typeof err !== "object" || err === null) return false;
  return "stdout" in err || "stderr" in err;
}

/** Commander signals `--help` / `--version` exits by throwing a zero-exit error. */
function isCommanderHelpExit(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record["exitCode"] === 0;
}

/** Default shell runner — wraps execa's Promise shape into {@link ShellResult}. */
async function defaultShell(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ShellResult> {
  const result = await execa(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    reject: true,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
  };
}

/** Default background spawn — wraps execa's ChildProcess into {@link SpawnHandle}. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): SpawnHandle {
  const child: ExecaChildProcess = execa(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    reject: false,
    stdio: "inherit",
  });
  return {
    exit: child.then((result) => ({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    })),
    kill: (signal) => {
      if (!child.killed) child.kill(signal ?? "SIGTERM");
    },
  };
}

/** Default sleep helper — `setTimeout` Promise wrapper. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default diagnostic logger — routes every level to stderr so the
 * harness's status lines never collide with a subprocess's stdout.
 *
 * Kept module-private with no `console.*` references so the codebase's
 * "no console" discipline (see `.eslintrc`, matched by zero hits across
 * `src/`) stays intact for the benchmark harness too.
 */
function defaultLogger(): HarnessLogger {
  return {
    info: (line) => process.stderr.write(`${line}\n`),
    warn: (line) => process.stderr.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

/**
 * Parse CLI argv into structured options. Exported so tests can assert
 * the flag shape without invoking Commander through a subprocess.
 */
export function parseHarnessArgs(argv: readonly string[]): HarnessCliOptions {
  const program = new Command();
  program
    .name("claw-bench")
    .description("Claw Studio end-to-end benchmark harness (#31)")
    .option("--repo <owner/repo>", "target benchmark repository")
    .option("--milestone <label>", "milestone label (default: v0.1)")
    .option("--initial-tag <tag>", "reset tag for main (default: initial)")
    .option("--timeout <seconds>", "wall-clock timeout in seconds", (v) =>
      parsePositiveInt(v, "--timeout"),
    )
    .option("--poll-interval <seconds>", "poll interval in seconds", (v) =>
      parsePositiveInt(v, "--poll-interval"),
    )
    .option("--tracking-issue <n>", "tracking issue number on claw-studio", (v) =>
      parsePositiveInt(v, "--tracking-issue"),
    )
    .option("--bench-root <path>", "benchmark state directory (default: ~/.claw-bench)")
    .option("--claw-bin <path>", "claw binary (default: claw)")
    .option("--dry-run", "stop after setup without spawning claw")
    .exitOverride();

  program.parse(argv as string[], { from: "user" });
  const opts = program.opts<{
    repo?: string;
    milestone?: string;
    initialTag?: string;
    timeout?: number;
    pollInterval?: number;
    trackingIssue?: number;
    benchRoot?: string;
    clawBin?: string;
    dryRun?: boolean;
  }>();

  const cli: HarnessCliOptions = {};
  if (opts.repo !== undefined) cli.repo = opts.repo;
  if (opts.milestone !== undefined) cli.milestone = opts.milestone;
  if (opts.initialTag !== undefined) cli.initialTag = opts.initialTag;
  if (opts.timeout !== undefined) cli.timeout = opts.timeout;
  if (opts.pollInterval !== undefined) cli.pollInterval = opts.pollInterval;
  if (opts.trackingIssue !== undefined) cli.trackingIssue = opts.trackingIssue;
  if (opts.benchRoot !== undefined) cli.benchRoot = opts.benchRoot;
  if (opts.clawBin !== undefined) cli.clawBin = opts.clawBin;
  if (opts.dryRun !== undefined) cli.dryRun = opts.dryRun;
  return cli;
}

/** Positive-integer validator for Commander option coercion. */
function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ClawError(
      `invalid value for ${flag}.`,
      "Pass a positive integer.",
    );
  }
  return parsed;
}

/** CLI entrypoint — rendered when this file is invoked as a tsx script. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const log = defaultLogger();
  try {
    const cli = parseHarnessArgs(argv);
    const options = resolveOptions(cli);
    await runBenchmark(options, { logger: log });
    return 0;
  } catch (err) {
    // Commander's `--help` / `--version` paths throw with an `exitCode: 0`
    // under `exitOverride()` — surface them as a clean exit, not a crash.
    if (isCommanderHelpExit(err)) return 0;
    if (isClawError(err)) {
      log.error(`[CLAW] Stopped — ${err.message}`);
      if (err.hint) log.error(err.hint);
    } else {
      log.error(`[bench] unexpected error: ${formatError(err)}`);
    }
    return 1;
  }
}

const entryPath = process.argv[1];
const invokedDirectly =
  typeof entryPath === "string" && import.meta.url === pathToFileURL(entryPath).href;
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
