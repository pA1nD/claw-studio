import { join } from "node:path";

/**
 * Canonical paths of every file `claw setup` creates in a target repo.
 *
 * Centralised here so preflight, writers, and rollback all operate on the
 * exact same set. Any new file in the footprint is added in one place.
 */
export interface SetupPaths {
  /** The `.claw/` directory that holds everything Claw Studio owns. */
  clawDir: string;
  /** `.claw/CLAUDE.md` — generated agent instructions for this project. */
  claudeMd: string;
  /** `.claw/config.json` — `{ repo, pollInterval, clawVersion }`. */
  configJson: string;
  /** `.claw/sessions/` — in-flight agent session state (created empty). */
  sessionsDir: string;
  /** `.github/workflows/` — required for GitHub Actions to pick up `ci.yml`. */
  workflowsDir: string;
  /** `.github/workflows/ci.yml` — the full Claw Studio pipeline. */
  ciYml: string;
}

/**
 * Required human-authored paths that must exist before setup can run.
 * Claw Studio reads these but never modifies them.
 */
export interface RequiredPaths {
  /** `README.md` — project description. */
  readme: string;
  /** `ROADMAP.md` — milestone and issue ordering. */
  roadmap: string;
}

/**
 * Resolve every path `claw setup` touches, relative to the given working
 * directory.
 *
 * @param cwd absolute path to the target project's working directory
 * @returns the full set of paths used by preflight, writers, and rollback
 */
export function resolveSetupPaths(cwd: string): SetupPaths {
  const clawDir = join(cwd, ".claw");
  const workflowsDir = join(cwd, ".github", "workflows");
  return {
    clawDir,
    claudeMd: join(clawDir, "CLAUDE.md"),
    configJson: join(clawDir, "config.json"),
    sessionsDir: join(clawDir, "sessions"),
    workflowsDir,
    ciYml: join(workflowsDir, "ci.yml"),
  };
}

/**
 * Resolve the human-authored paths that must exist before setup can proceed.
 *
 * @param cwd absolute path to the target project's working directory
 * @returns the full set of required paths
 */
export function resolveRequiredPaths(cwd: string): RequiredPaths {
  return {
    readme: join(cwd, "README.md"),
    roadmap: join(cwd, "ROADMAP.md"),
  };
}
