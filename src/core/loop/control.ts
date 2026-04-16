import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSetupPaths } from "../setup/paths.js";

/**
 * Resolve the paths used to coordinate `claw pause`, `claw resume`, and
 * `claw stop` between the running loop and the CLI commands that signal it.
 *
 * Lives under `.claw/control/` so a `cat .claw/config.json` ls never confuses
 * "stop" / "pause" with project-managed files.
 */
export function controlPaths(cwd: string): {
  /** Directory holding control flags. */
  controlDir: string;
  /** Empty file whose presence means "pause after the current action". */
  pauseFlag: string;
  /** Empty file whose presence means "stop cleanly at the next checkpoint". */
  stopFlag: string;
} {
  const controlDir = join(resolveSetupPaths(cwd).clawDir, "control");
  return {
    controlDir,
    pauseFlag: join(controlDir, "pause"),
    stopFlag: join(controlDir, "stop"),
  };
}

/** Injectable filesystem seam so tests can drive the flags without disk I/O. */
export interface ControlFs {
  /** True when `path` exists. */
  exists: (path: string) => Promise<boolean>;
  /** Create `path` (empty file), creating parent directories as needed. */
  writeEmpty: (path: string) => Promise<void>;
  /** Delete `path`. Must be a no-op when the file does not exist. */
  remove: (path: string) => Promise<void>;
}

/**
 * Set the pause flag so the running loop pauses after its current action.
 *
 * The loop polls `pauseFlag` between cycles — `claw pause` is therefore
 * non-destructive: any in-flight implementation agent run completes before the
 * loop honours the pause.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 */
export async function setPauseFlag(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<void> {
  await fs.writeEmpty(controlPaths(cwd).pauseFlag);
}

/**
 * Clear the pause flag. The loop resumes from its next poll.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 */
export async function clearPauseFlag(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<void> {
  await fs.remove(controlPaths(cwd).pauseFlag);
}

/**
 * Read the pause flag.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 * @returns true when the loop is paused
 */
export async function isPaused(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<boolean> {
  return fs.exists(controlPaths(cwd).pauseFlag);
}

/**
 * Set the stop flag so the running loop exits cleanly at the next checkpoint.
 *
 * Like {@link setPauseFlag}, this is non-destructive — the in-flight action
 * completes before the loop checks the flag and exits.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 */
export async function setStopFlag(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<void> {
  await fs.writeEmpty(controlPaths(cwd).stopFlag);
}

/**
 * Clear the stop flag — called by `claw start` on entry so a stale stop from a
 * previous run does not immediately terminate the loop.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 */
export async function clearStopFlag(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<void> {
  await fs.remove(controlPaths(cwd).stopFlag);
}

/**
 * Read the stop flag.
 *
 * @param cwd target project working directory
 * @param fs  optional filesystem seam for testing
 * @returns true when the loop has been asked to stop
 */
export async function isStopped(
  cwd: string,
  fs: ControlFs = defaultControlFs,
): Promise<boolean> {
  return fs.exists(controlPaths(cwd).stopFlag);
}

/** Default filesystem seam — reads/writes through `node:fs/promises`. */
export const defaultControlFs: ControlFs = {
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  writeEmpty: async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", "utf8");
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
};
