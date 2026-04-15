import { execa } from "execa";
import { ClawError } from "../types/errors.js";

/** Options for spawning a fresh Claude implementation session. */
export interface SpawnOptions {
  /** Absolute path to the `.claw/CLAUDE.md` used as the `--system-prompt`. */
  systemPromptPath: string;
  /** Full prompt — flows through stdin, never argv. */
  prompt: string;
  /** Working directory for the subprocess (the target repo checkout). */
  cwd: string;
  /** Optional hard timeout in milliseconds. Defaults to {@link DEFAULT_CLAUDE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional dependency seam for testing. */
  deps?: ClaudeDeps;
}

/** Options for resuming an existing Claude session. */
export interface ResumeOptions {
  /** Claude session ID persisted in `.claw/sessions/{N}.json`. */
  sessionId: string;
  /** Fix-cycle prompt. */
  prompt: string;
  /** Working directory for the subprocess. */
  cwd: string;
  /** Optional hard timeout in milliseconds. Defaults to {@link DEFAULT_CLAUDE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional dependency seam for testing. */
  deps?: ClaudeDeps;
}

/** Result of a Claude invocation. */
export interface ClaudeResult {
  /** The Claude session ID the caller must persist for resuming later. */
  sessionId: string;
  /**
   * The `result` string Claude returned — used for the PR summary. Always a
   * (possibly empty) string; the caller is responsible for trimming.
   */
  resultText: string;
}

/**
 * Dependencies injected into {@link spawnImplementationSession} and
 * {@link resumeImplementationSession}. The runtime defaults shell out to the
 * `claude` CLI; tests inject a stub that captures the arguments passed.
 */
export interface ClaudeDeps {
  /**
   * Run `claude -p` (or `claude -p --resume`) and resolve with the parsed
   * result. The raw invocation belongs here so tests can assert on the exact
   * command without running a subprocess.
   */
  runClaude?: (invocation: ClaudeInvocation) => Promise<ClaudeResult>;
}

/**
 * Fully-structured invocation description — the shape the runtime default
 * turns into an `execa("claude", [...])` call. Exposed so tests can assert on
 * the exact arguments the runtime would have invoked.
 */
export interface ClaudeInvocation {
  /** CLI arguments passed to `claude`. */
  args: readonly string[];
  /** The prompt streamed on stdin — never argv, per CLAUDE.md's stdin rule. */
  stdin: string;
  /** Working directory for the subprocess. */
  cwd: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
}

/** How long we wait on `claude -p` before assuming it has stalled. */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Spawn a fresh `claude -p` session to implement an issue.
 *
 * The `--output-format json` flag makes Claude emit a single JSON document
 * containing the final `result` text and the `session_id` we persist to
 * `.claw/sessions/{N}.json` for the fix cycle. The prompt goes through stdin
 * because large README/ROADMAP combinations would otherwise trip `ARG_MAX`
 * and because argv content is visible to every local user via
 * `/proc/[pid]/cmdline`.
 *
 * @param options system prompt path + prompt + cwd + optional deps
 * @returns the session ID and the result text Claude reported
 * @throws {ClawError} when the `claude` binary is missing, times out, or exits non-zero
 */
export async function spawnImplementationSession(
  options: SpawnOptions,
): Promise<ClaudeResult> {
  const runClaude = options.deps?.runClaude ?? defaultRunClaude;
  return runClaude({
    args: [
      "-p",
      "--system-prompt",
      options.systemPromptPath,
      "--output-format",
      "json",
    ],
    stdin: options.prompt,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS,
  });
}

/**
 * Resume an existing Claude session to address review feedback.
 *
 * The session ID must come from `.claw/sessions/{N}.json` — no fresh session
 * is created here, because the fix agent MUST share context with the
 * implementation agent (see issue spec: "the agent that writes the code is
 * the agent that fixes it"). Creating a new session here would be the drift
 * the architecture is designed to prevent.
 *
 * @param options session id + fix prompt + cwd + optional deps
 * @returns the (same) session id and the result text Claude reported
 * @throws {ClawError} when the `claude` binary is missing, times out, or exits non-zero
 */
export async function resumeImplementationSession(
  options: ResumeOptions,
): Promise<ClaudeResult> {
  const runClaude = options.deps?.runClaude ?? defaultRunClaude;
  return runClaude({
    args: [
      "-p",
      "--resume",
      options.sessionId,
      "--output-format",
      "json",
    ],
    stdin: options.prompt,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS,
  });
}

/**
 * Runtime `runClaude` — shells out via `execa`, parses the JSON payload, and
 * lifts common failure modes (missing binary, timeout, non-zero exit, bad
 * JSON) into {@link ClawError} so the loop surfaces them in the standard
 * `[CLAW] Stopped` shape.
 */
async function defaultRunClaude(invocation: ClaudeInvocation): Promise<ClaudeResult> {
  try {
    const { stdout } = await execa("claude", [...invocation.args], {
      input: invocation.stdin,
      cwd: invocation.cwd,
      timeout: invocation.timeoutMs,
    });
    return parseClaudeOutput(stdout);
  } catch (err: unknown) {
    if (isCommandNotFound(err)) {
      throw new ClawError(
        "`claude` CLI not found on PATH.",
        "Install Claude Code before running the loop: https://docs.anthropic.com/en/docs/claude-code",
      );
    }
    if (isTimeout(err)) {
      throw new ClawError(
        "`claude -p` did not respond in time.",
        `The subprocess was killed after ${Math.round(invocation.timeoutMs / 1000)}s. Re-run \`claw start\` to retry.`,
      );
    }
    if (err instanceof ClawError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      "`claude -p` failed.",
      `Underlying error: ${detail}`,
    );
  }
}

/**
 * Parse Claude's `--output-format json` payload into a {@link ClaudeResult}.
 *
 * Exposed so tests can exercise the parser without building a subprocess
 * fixture. Accepts the `{ session_id, result }` shape Claude emits today and
 * surfaces a typed error for anything else.
 *
 * @param stdout the full stdout of the `claude` invocation
 * @returns the parsed result
 * @throws {ClawError} when the payload is missing required fields
 */
export function parseClaudeOutput(stdout: string): ClaudeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ClawError(
      "could not parse `claude -p` output.",
      "Expected a JSON document from `--output-format json`. Re-run `claw start`.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ClawError(
      "`claude -p` output was not a JSON object.",
      "Expected `{ session_id, result }`. Re-run `claw start`.",
    );
  }
  const shape = parsed as Record<string, unknown>;
  const sessionId = shape["session_id"];
  const result = shape["result"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ClawError(
      "`claude -p` output is missing `session_id`.",
      "Claude Code must emit a session id for the fix cycle to resume the same session.",
    );
  }
  return {
    sessionId,
    resultText: typeof result === "string" ? result : "",
  };
}

/**
 * Narrow a thrown value to "command not found" — mirrors the check in
 * `core/setup/claude-md.ts` so the error shape is identical across both
 * subprocess call sites.
 */
function isCommandNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record["code"] === "ENOENT" || record["errno"] === -2;
}

/** Narrow a thrown value to an `execa` timeout. */
function isTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<string, unknown>)["timedOut"] === true;
}
