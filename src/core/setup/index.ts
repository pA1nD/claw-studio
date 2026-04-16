import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { createClient } from "../github/client.js";
import type { RepoRef } from "../github/repo-detect.js";
import { canAccessRepoVia, runPreflight } from "./preflight.js";
import type { PreflightDeps } from "./preflight.js";
import { buildConfig, serializeConfig } from "./config.js";
import { generateClaudeMd } from "./claude-md.js";
import type { GenerateClaudeMdDeps } from "./claude-md.js";
import { loadCiTemplate } from "./ci-template.js";
import type { LoadCiTemplateDeps } from "./ci-template.js";
import {
  REQUIRED_STATUS_CHECKS,
  configureBranchProtection,
} from "./branch-protection.js";
import { resolveSetupPaths } from "./paths.js";
import { WriteTracker } from "./write.js";
import type { WriteTrackerFs } from "./write.js";
import { resolveTokens } from "./token-resolver.js";
import type {
  ResolveTokensDeps,
  ResolvedTokens,
  TokenOverrides,
} from "./token-resolver.js";
import { writeEnvFile, readEnvFile, mergeEnvFile } from "./env-file.js";
import type { EnvFileFs } from "./env-file.js";
import { pushRepoActionsSecret } from "./secret.js";
import type { PushRepoActionsSecretDeps } from "./secret.js";
import {
  generateRunnerComposeFile,
  requestRunnerRegistrationToken,
  startRunners,
} from "./docker-runners.js";
import type { RunnerComposeFs, StartRunnersDeps } from "./docker-runners.js";
import { ensureClawIsGitignored } from "./gitignore.js";
import type { GitignoreFs } from "./gitignore.js";

/**
 * Hooks the CLI uses to surface the confirmation prompt and progress updates.
 *
 * `claw setup` is fully headless by default (per issue #30) — the runner
 * registration and token-secret paths no longer require human input. The
 * only interactive step that remains is the confirmation, and `--yes`
 * removes that too.
 */
export interface SetupHooks {
  /**
   * Prompt the human to confirm. Return `true` to proceed, `false` to abort.
   * The orchestrator guarantees no files have been touched before this call.
   * When `RunSetupOptions.yes` is true the orchestrator auto-resolves `true`
   * without calling this hook — useful for CI and the benchmark harness.
   */
  confirm: (plan: SetupPlan) => Promise<boolean>;
  /** Optional progress ping fired around significant phases. */
  onPhase?: (phase: SetupPhase) => void;
}

/** Summary of what setup will do — consumed by the confirmation UI. */
export interface SetupPlan {
  /** Target repository. */
  ref: RepoRef;
  /** Paths that will be created. */
  filesToCreate: readonly string[];
  /** Required status checks that will be set on the default branch. */
  requiredChecks: readonly string[];
  /** True when `--overwrite` is active and existing files will be replaced. */
  overwrite: boolean;
  /** True when runner provisioning is skipped via `--skip-runners`. */
  skipRunners: boolean;
  /** Number of Docker runners to provision (0 when {@link SetupPlan.skipRunners}). */
  runnerCount: number;
}

/** Phases of the setup flow. Emitted via {@link SetupHooks.onPhase}. */
export type SetupPhase =
  | "preflight"
  | "resolving-tokens"
  | "writing-env"
  | "writing-config"
  | "writing-gitignore"
  | "writing-claude-md"
  | "writing-ci"
  | "branch-protection"
  | "pushing-secret"
  | "starting-runners"
  | "complete";

/** Options accepted by {@link runSetup}. */
export interface RunSetupOptions {
  /** Target repository (already resolved from `--repo` / config / git remote). */
  ref: RepoRef;
  /** Working directory for file I/O. */
  cwd: string;
  /** When true, skip the "files already exist" preflight and replace on write. */
  overwrite: boolean;
  /** When true, bypass the confirmation prompt (mirrors `--yes`). */
  yes?: boolean;
  /** When true, skip Docker runner provisioning (mirrors `--skip-runners`). */
  skipRunners?: boolean;
  /** Override the default runner count (mirrors `--runner-count <N>`). */
  runnerCount?: number;
  /** CLI-flag token overrides (`--github-pat`, `--claude-token`). */
  tokens?: TokenOverrides;
  /** Hooks that drive the interactive parts of the flow. */
  hooks: SetupHooks;
  /** Dependency injection seam for tests. */
  deps?: RunSetupDeps;
}

/** Injectable dependencies for the whole setup flow. */
export interface RunSetupDeps {
  /**
   * Factory for the Octokit client. Called AFTER token resolution so the
   * client uses the resolved PAT (not whatever happened to be in
   * `process.env.GITHUB_PAT` when the CLI launched). Tests inject a stub
   * that returns a mock Octokit without ever touching `createClient()`.
   */
  makeOctokit?: (githubPat: string) => Octokit;
  /** Filesystem primitives for the write tracker (see {@link WriteTracker}). */
  fs?: WriteTrackerFs;
  /** Preflight seams (file-exists + repo-reachable). */
  preflight?: PreflightDeps;
  /** Token-resolver seams. */
  tokens?: ResolveTokensDeps;
  /** `.claw/.env` read/write seams. */
  envFile?: EnvFileFs;
  /** `.gitignore` read/write seams. */
  gitignore?: GitignoreFs;
  /** CLAUDE.md generator seams. */
  claudeMd?: GenerateClaudeMdDeps;
  /** ci.yml template loader seams. */
  ciTemplate?: LoadCiTemplateDeps;
  /** Secret encryption seams. */
  secret?: PushRepoActionsSecretDeps;
  /** Runner compose-file writer seams. */
  runnerCompose?: RunnerComposeFs;
  /** Runner lifecycle seams (Docker availability, compose up, polling). */
  runners?: StartRunnersDeps;
}

/**
 * Run the full `claw setup` flow — headless by default.
 *
 * Flow:
 *   1.  Preflight — 4 checks, first failure halts (CHECK 4 skipped if overwrite)
 *   2.  Resolve tokens — flag > env > `.claw/.env` > halt
 *   3.  Confirmation — bypassed when `yes: true`
 *   4.  Persist resolved tokens to `.claw/.env` (0600 perms)
 *   5.  Ensure `.claw/` is in the project's `.gitignore`
 *   6.  Write `.claw/config.json`, `.claw/CLAUDE.md`, `.github/workflows/ci.yml`
 *   7.  Configure branch protection
 *   8.  Push `CLAUDE_CODE_OAUTH_TOKEN` as a repo Actions secret via the API
 *   9.  When `skipRunners` is false: request a registration token, write
 *       `.claw/runners/docker-compose.yml`, run `docker compose up -d`, poll
 *       until at least one runner is online
 *
 * File writes in phase 4-6 and the compose file in phase 9 are all tracked
 * by {@link WriteTracker} so a downstream failure rolls them back atomically.
 * GitHub-side side effects (branch protection, secret push) are never
 * "rolled back" automatically — the loop's `claw status` will surface any
 * divergence the next time it runs.
 *
 * @param options target + hooks + flags + injected deps
 * @returns `true` on successful completion, `false` when the human declined
 */
export async function runSetup(options: RunSetupOptions): Promise<boolean> {
  const {
    ref,
    cwd,
    overwrite,
    hooks,
    yes = false,
    skipRunners = false,
  } = options;

  // 1. Preflight — everything except repo-access runs from local state so
  //    we can fail fast before touching GitHub. Repo access runs here too
  //    because token resolution happens next and we want the clearest error
  //    surface when the user forgot to pass a token.
  hooks.onPhase?.("preflight");
  // Use a placeholder client only for the repo-access check; we build the
  // real one from the resolved PAT in the next step.
  const preflightClient = options.deps?.makeOctokit
    ? options.deps.makeOctokit("preflight-placeholder")
    : null;
  await runPreflight({
    ref,
    cwd,
    overwrite,
    deps: {
      canAccessRepo:
        options.deps?.preflight?.canAccessRepo ??
        (preflightClient ? canAccessRepoVia(preflightClient) : undefined),
      fileExists: options.deps?.preflight?.fileExists,
    },
  });

  // 2. Resolve tokens — flag > env > .claw/.env > halt
  hooks.onPhase?.("resolving-tokens");
  const resolved = await resolveTokens(cwd, options.tokens ?? {}, {
    ...options.deps?.tokens,
    envFileFs: options.deps?.tokens?.envFileFs ?? options.deps?.envFile,
  });

  // Build the Octokit now that we have the real PAT. Tests inject a factory
  // that ignores the PAT and returns a spy-friendly stub.
  const octokit: Octokit = options.deps?.makeOctokit
    ? options.deps.makeOctokit(resolved.githubPat.value)
    : createClient({ readToken: () => resolved.githubPat.value });

  // Make the resolved PAT visible to every downstream module that reads
  // `process.env.GITHUB_PAT` (the loop, the inspector, the PR monitor).
  // We only mutate when the value differs — no surprise clobber of whatever
  // the caller had set explicitly for this invocation.
  if (process.env["GITHUB_PAT"] !== resolved.githubPat.value) {
    process.env["GITHUB_PAT"] = resolved.githubPat.value;
  }

  // 3. Confirmation — surface the plan, bail out cleanly if the human says no.
  const paths = resolveSetupPaths(cwd);
  const runnerCount = resolveRunnerCount(options.runnerCount);
  const plan = buildSetupPlan(ref, overwrite, { skipRunners, runnerCount });
  if (!yes) {
    const proceed = await hooks.confirm(plan);
    if (!proceed) {
      return false;
    }
  }

  // 4. Tracked writes — rollback is atomic across every tracked artifact.
  const tracker = new WriteTracker(options.deps?.fs);
  try {
    hooks.onPhase?.("writing-env");
    await writeResolvedTokens({
      cwd,
      resolved,
      envFileFs: options.deps?.envFile,
    });
    // Only track the write AFTER it succeeds — writeResolvedTokens uses its
    // own injectable seam, and we don't want rollback to try to remove a
    // file that never made it to disk.
    tracker.track({ path: paths.envFile, kind: "file" });

    hooks.onPhase?.("writing-config");
    const config = buildConfig(ref, undefined, runnerCount);
    await tracker.writeFile(paths.configJson, serializeConfig(config));
    await tracker.mkdir(paths.sessionsDir);

    hooks.onPhase?.("writing-gitignore");
    // We deliberately do NOT track the .gitignore write — the file belongs
    // to the human, and rolling back a single-line append could remove
    // unrelated entries added between runs. Worst case on failure: an
    // extra `.claw/` line in the gitignore, which is harmless.
    await ensureClawIsGitignored(paths.gitignore, options.deps?.gitignore);

    hooks.onPhase?.("writing-claude-md");
    const claudeMdContents = await generateClaudeMd({
      cwd,
      deps: options.deps?.claudeMd,
    });
    await tracker.writeFile(paths.claudeMd, claudeMdContents);

    hooks.onPhase?.("writing-ci");
    const ci = await loadCiTemplate({
      repo: `${ref.owner}/${ref.repo}`,
      deps: options.deps?.ciTemplate,
    });
    await tracker.writeFile(paths.ciYml, ci);

    hooks.onPhase?.("branch-protection");
    await configureBranchProtection({ ref, octokit });

    hooks.onPhase?.("pushing-secret");
    await pushRepoActionsSecret({
      ref,
      octokit,
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: resolved.claudeToken.value,
      deps: options.deps?.secret,
    });

    if (!skipRunners) {
      hooks.onPhase?.("starting-runners");
      const registrationToken = await requestRunnerRegistrationToken({
        ref,
        octokit,
      });
      await generateRunnerComposeFile({
        ref,
        runnerCount,
        registrationToken,
        claudeToken: resolved.claudeToken.value,
        path: paths.composeFile,
        fs: options.deps?.runnerCompose,
      });
      tracker.track({ path: paths.composeFile, kind: "file" });
      await startRunners({
        ref,
        octokit,
        composeFile: paths.composeFile,
        deps: options.deps?.runners,
      });
    }
  } catch (err) {
    // Always roll back before re-throwing — see the comment on the old flow:
    // losing the original cause is the worst failure mode the human can face.
    const rollbackFailures = await tracker.rollback();

    const original =
      err instanceof ClawError
        ? err
        : new ClawError(
            "setup failed before it could finish.",
            err instanceof Error ? err.message : String(err),
          );

    if (rollbackFailures.length === 0) {
      throw original;
    }

    const hint = [
      original.hint,
      `Also: rollback could not remove ${rollbackFailures.join(", ")} — delete manually.`,
    ]
      .filter((line): line is string => Boolean(line))
      .join(" ");
    throw new ClawError(original.message, hint);
  }

  hooks.onPhase?.("complete");
  return true;
}

/**
 * Merge the resolved tokens into whatever `.claw/.env` currently contains
 * (if anything) and write the file back.
 *
 * Reading first means a human who put a comment or extra variable in the
 * file doesn't see it clobbered on the next `claw setup`.
 */
async function writeResolvedTokens(options: {
  cwd: string;
  resolved: ResolvedTokens;
  envFileFs?: EnvFileFs;
}): Promise<void> {
  const { cwd, resolved, envFileFs } = options;
  const paths = resolveSetupPaths(cwd);
  const existing = await readEnvFile(paths.envFile, envFileFs);
  const merged = mergeEnvFile(existing, {
    GITHUB_PAT: resolved.githubPat.value,
    CLAUDE_CODE_OAUTH_TOKEN: resolved.claudeToken.value,
  });
  await writeEnvFile(paths.envFile, merged, envFileFs);
}

/**
 * Validate `--runner-count` from the CLI and fall back to the default
 * when it is not passed. Any invalid value halts before any side effect.
 */
function resolveRunnerCount(requested: number | undefined): number {
  if (requested === undefined) return 6;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new ClawError(
      `invalid --runner-count: ${requested}.`,
      "Pass --runner-count <N> with a positive integer.",
    );
  }
  return requested;
}

/**
 * Assemble the {@link SetupPlan} shown in the confirmation UI.
 *
 * Paths are reported relative to the working directory for display; the
 * absolute equivalents live on the {@link SetupPaths} the orchestrator
 * resolves internally. Exposed so tests can verify the plan matches the
 * file footprint from ARCHITECTURE.md.
 */
export function buildSetupPlan(
  ref: RepoRef,
  overwrite: boolean,
  options: { skipRunners?: boolean; runnerCount?: number } = {},
): SetupPlan {
  const skipRunners = options.skipRunners ?? false;
  const runnerCount = skipRunners ? 0 : (options.runnerCount ?? 6);
  const filesToCreate: string[] = [
    ".claw/.env",
    ".claw/CLAUDE.md",
    ".claw/config.json",
    ".github/workflows/ci.yml",
  ];
  if (!skipRunners) {
    filesToCreate.push(".claw/runners/docker-compose.yml");
  }
  return {
    ref,
    filesToCreate,
    // Single source of truth — what we show the human must exactly match
    // what we configure on the branch, or the confirmation becomes a lie.
    requiredChecks: [...REQUIRED_STATUS_CHECKS],
    overwrite,
    skipRunners,
    runnerCount,
  };
}
