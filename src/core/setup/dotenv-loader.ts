import { readEnvFile } from "./env-file.js";
import type { EnvFileFs } from "./env-file.js";
import { resolveSetupPaths } from "./paths.js";

/** Return-shape for {@link loadDotenvIntoProcessEnv}. */
export interface DotenvLoadResult {
  /** Absolute path of the `.env` file that was consulted. */
  path: string;
  /** True when the file existed and parsed successfully. */
  found: boolean;
  /** Names of keys that were written to `process.env` by this load. */
  applied: readonly string[];
}

/**
 * Load `.claw/.env` into `process.env` without clobbering existing values.
 *
 * Called once at CLI entrypoint (in `src/cli/index.tsx`) so every subsequent
 * call to `createClient()` or any module reading `process.env.GITHUB_PAT`
 * sees the persisted tokens. An explicit environment variable still wins —
 * the file is the persistence layer, not the source of truth when the user
 * wants to override for a single invocation.
 *
 * Missing files are not an error: on first run `.claw/.env` does not exist,
 * and the rest of the CLI surfaces its own "token missing" error with
 * clearer guidance than this loader could.
 *
 * @param cwd target working directory (where `.claw/` lives)
 * @param env process env to write into — defaults to `process.env`
 * @param fs  optional filesystem seam for tests
 * @returns summary of what was loaded — useful for diagnostics
 */
export async function loadDotenvIntoProcessEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  fs: EnvFileFs = {},
): Promise<DotenvLoadResult> {
  const path = resolveSetupPaths(cwd).envFile;
  const parsed = await readEnvFile(path, fs);
  const applied: string[] = [];
  if (parsed.raw.size === 0) {
    return { path, found: false, applied };
  }
  for (const [key, value] of parsed.raw) {
    if (env[key] !== undefined && env[key] !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return { path, found: true, applied };
}
