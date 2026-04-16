import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSetupPaths } from "../setup/paths.js";

/** Absolute path of the loop's append-only history log. */
export function logPath(cwd: string): string {
  return join(resolveSetupPaths(cwd).clawDir, "loop.log");
}

/** Injectable filesystem seam so tests can drive the log without disk I/O. */
export interface LogFs {
  /** Append `contents` to `path`, creating parent directories as needed. */
  appendFile: (path: string, contents: string) => Promise<void>;
  /** Read the file as UTF-8 — must resolve to `null` when the file is missing. */
  readFile: (path: string) => Promise<string | null>;
}

/**
 * Append a single timestamped entry to `.claw/loop.log`.
 *
 * Format is `ISO-timestamp\tline\n` so the log is grep-friendly and easy to
 * stream with `tail -f`. Each call writes atomically — newline-terminated and
 * never partial.
 *
 * @param cwd  target project working directory
 * @param line the human-readable line to record
 * @param fs   optional filesystem seam for testing
 * @param now  optional time source for testing (defaults to `new Date()`)
 */
export async function appendLog(
  cwd: string,
  line: string,
  fs: LogFs = defaultFs,
  now: () => Date = () => new Date(),
): Promise<void> {
  const stamp = now().toISOString();
  await fs.appendFile(logPath(cwd), `${stamp}\t${line}\n`);
}

/**
 * Read the last `n` log entries.
 *
 * Returns the lines in chronological order (oldest first). When the file does
 * not exist returns an empty array — `claw logs` on a fresh repo prints
 * nothing rather than halting.
 *
 * @param cwd target project working directory
 * @param n   maximum number of entries to return (negative or zero → empty)
 * @param fs  optional filesystem seam for testing
 * @returns the trailing entries, oldest first
 */
export async function readLastEntries(
  cwd: string,
  n: number,
  fs: LogFs = defaultFs,
): Promise<string[]> {
  if (n <= 0) return [];
  const raw = await fs.readFile(logPath(cwd));
  if (raw === null) return [];
  // `split`/`filter` over `splitLines` to preserve the simple `\n` semantics
  // every log line is written with — embedded CRs are preserved as-is.
  const lines = raw.split("\n").filter((l) => l.length > 0);
  return lines.slice(-n);
}

/** Default filesystem seam — reads/writes through `node:fs/promises`. */
const defaultFs: LogFs = {
  appendFile: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, contents, "utf8");
  },
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
};
