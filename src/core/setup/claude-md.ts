import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { ClawError } from "../types/errors.js";
import { resolveRequiredPaths } from "./paths.js";

/** Options accepted by {@link generateClaudeMd}. */
export interface GenerateClaudeMdOptions {
  /** Working directory — README.md and ROADMAP.md are read from its root. */
  cwd: string;
  /** Injected dependencies for testing. */
  deps?: GenerateClaudeMdDeps;
}

/** Injectable dependencies so generation can be unit-tested without Claude or the filesystem. */
export interface GenerateClaudeMdDeps {
  /** Read a file as UTF-8. Defaults to `fs.readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
  /**
   * Invoke the generator backend. The real implementation shells out to
   * `claude -p`; tests inject a stub that returns a canned markdown string.
   *
   * @param prompt the prompt to send to the agent
   * @returns the generated CLAUDE.md contents
   */
  runGenerator?: (prompt: string) => Promise<string>;
}

/**
 * Prompt used to ask the `claude` CLI to write a tailored `CLAUDE.md`.
 *
 * Kept as a named export so tests can verify the exact string — a regression
 * in this prompt directly changes the quality of agent output for every
 * repo Claw Studio sets up.
 */
export const CLAUDE_MD_PROMPT = [
  "Read the README.md and ROADMAP.md of this project, which are included below.",
  "Write a CLAUDE.md that an AI coding agent would need to implement issues for this project.",
  "Include: tech stack, project structure, coding conventions, and what to avoid.",
  "Be specific to THIS project — not generic. Do not invent facts. If the source files do not",
  "mention something, leave it out. Output only the CLAUDE.md markdown, no preamble.",
].join(" ");

/**
 * Generate a project-specific `CLAUDE.md` by feeding `README.md` and
 * `ROADMAP.md` to the `claude` CLI.
 *
 * The output is deliberately not a generic template — per issue #18 each
 * target repo gets instructions tailored to its own stack, structure, and
 * conventions. The setup step shells out to the `claude` binary, which
 * the human is assumed to have installed locally (it is the same CLI
 * used by the loop's implementation agent).
 *
 * @param options cwd + optional injected deps
 * @returns the markdown string to write to `.claw/CLAUDE.md`
 * @throws {ClawError} when README or ROADMAP cannot be read, or the generator fails
 */
export async function generateClaudeMd(
  options: GenerateClaudeMdOptions,
): Promise<string> {
  const read = options.deps?.readFile ?? defaultReadFile;
  const runGenerator = options.deps?.runGenerator ?? defaultRunGenerator;
  const paths = resolveRequiredPaths(options.cwd);

  const [readme, roadmap] = await Promise.all([
    read(paths.readme).catch(() => {
      throw new ClawError(
        "could not read README.md.",
        "Add a README.md describing your project before running setup.",
      );
    }),
    read(paths.roadmap).catch(() => {
      throw new ClawError(
        "could not read ROADMAP.md.",
        "Add a ROADMAP.md with at least one milestone before running setup.",
      );
    }),
  ]);

  const prompt = buildPrompt(readme, roadmap);
  const generated = await runGenerator(prompt);
  const trimmed = generated.trim();
  if (trimmed.length === 0) {
    throw new ClawError(
      "CLAUDE.md generator returned empty output.",
      "Re-run `claw setup`. If this persists, check `claude -p` works on its own.",
    );
  }
  return `${trimmed}\n`;
}

/**
 * Assemble the full prompt by appending the README and ROADMAP bodies to
 * {@link CLAUDE_MD_PROMPT}. Exposed for tests.
 */
export function buildPrompt(readme: string, roadmap: string): string {
  return [
    CLAUDE_MD_PROMPT,
    "",
    "--- BEGIN README.md ---",
    readme.trim(),
    "--- END README.md ---",
    "",
    "--- BEGIN ROADMAP.md ---",
    roadmap.trim(),
    "--- END ROADMAP.md ---",
  ].join("\n");
}

/** Default file reader. */
function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** How long we wait on `claude -p` before assuming it has stalled. */
const CLAUDE_TIMEOUT_MS = 120_000;

/**
 * Default generator — shells out to `claude -p` with the prompt on stdin.
 *
 * The prompt goes through stdin, not argv, for two reasons:
 *   1. Linux `ARG_MAX` is ~2MB — a large README + ROADMAP would fail with
 *      `E2BIG` when the prompt is an argv entry.
 *   2. Process arguments are world-readable via `/proc/[pid]/cmdline` on
 *      Linux, so passing user content on argv exposes it to every local
 *      user for the lifetime of the process.
 *
 * A 2-minute timeout prevents a stalled `claude` process from hanging
 * setup indefinitely — the human gets a typed, actionable error instead
 * of an apparent freeze.
 */
async function defaultRunGenerator(prompt: string): Promise<string> {
  try {
    const { stdout } = await execa("claude", ["-p"], {
      input: prompt,
      timeout: CLAUDE_TIMEOUT_MS,
    });
    return stdout;
  } catch (err: unknown) {
    if (isCommandNotFound(err)) {
      throw new ClawError(
        "`claude` CLI not found on PATH.",
        "Install Claude Code before running setup: https://docs.anthropic.com/en/docs/claude-code",
      );
    }
    if (isTimeout(err)) {
      throw new ClawError(
        "`claude -p` did not respond in time while generating CLAUDE.md.",
        `The subprocess was killed after ${CLAUDE_TIMEOUT_MS / 1000}s. Check your Claude connection and re-run \`claw setup\`.`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      "`claude -p` failed while generating CLAUDE.md.",
      `Run the command manually to diagnose. Underlying error: ${detail}`,
    );
  }
}

/**
 * Narrow a thrown value to "command not found" — matches execa's shape for
 * ENOENT without depending on its internal types.
 */
function isCommandNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record["code"] === "ENOENT" || record["errno"] === -2;
}

/**
 * Narrow a thrown value to an execa timeout. execa flags timed-out
 * subprocesses with `timedOut: true` on the thrown error object.
 */
function isTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<string, unknown>)["timedOut"] === true;
}
