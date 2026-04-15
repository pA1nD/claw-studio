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
import { hasOnlineRunner } from "./runners.js";
import { resolveSetupPaths } from "./paths.js";
import { WriteTracker } from "./write.js";
import type { WriteTrackerFs } from "./write.js";

/**
 * Hooks exposed to the CLI so the Ink surface can drive the setup flow
 * without the orchestrator knowing anything about React or the terminal.
 *
 * Each hook is awaited in sequence — the orchestrator respects the order
 * prescribed by issue #18 (preflight → confirmation → writes → branch
 * protection → human steps).
 */
export interface SetupHooks {
  /**
   * Prompt the human to confirm. Return `true` to proceed, `false` to abort.
   * The orchestrator guarantees no files have been touched before this call.
   */
  confirm: (plan: SetupPlan) => Promise<boolean>;
  /**
   * Walk the human through registering at least one self-hosted runner and
   * wait until {@link SetupHooks.verifyRunnerOnline} reports one is online.
   *
   * This hook is called AFTER files are written, per the "do these AFTER"
   * convention in issue #18.
   */
  walkRunnerStep: (context: HumanStepContext) => Promise<void>;
  /**
   * Walk the human through adding the `CLAUDE_CODE_OAUTH_TOKEN` secret to
   * the repo. The API cannot create repo secrets without the user's own
   * token unlocking its value, so this step is purely instructional.
   */
  walkTokenStep: (context: HumanStepContext) => Promise<void>;
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
}

/** Context passed to each human-step hook. */
export interface HumanStepContext {
  /** Target repository. */
  ref: RepoRef;
  /** Convenience: the GitHub web URL for the repo (no trailing slash). */
  repoUrl: string;
  /**
   * Poll the API for runner online state. Implementations of the hook call
   * this in a loop until it resolves to `true`.
   */
  verifyRunnerOnline?: () => Promise<boolean>;
}

/** Phases of the setup flow. Emitted via {@link SetupHooks.onPhase}. */
export type SetupPhase =
  | "preflight"
  | "writing-config"
  | "writing-claude-md"
  | "writing-ci"
  | "branch-protection"
  | "human-steps"
  | "complete";

/** Options accepted by {@link runSetup}. */
export interface RunSetupOptions {
  /** Target repository (already resolved from `--repo` / config / git remote). */
  ref: RepoRef;
  /** Working directory for file I/O. */
  cwd: string;
  /** When true, skip the "files already exist" preflight and replace on write. */
  overwrite: boolean;
  /** Hooks that drive the interactive parts of the flow. */
  hooks: SetupHooks;
  /** Dependency injection seam for tests. */
  deps?: RunSetupDeps;
}

/** Injectable dependencies for the whole setup flow. */
export interface RunSetupDeps {
  /** Override the Octokit client — defaults to `createClient()`. */
  octokit?: Octokit;
  /** Filesystem primitives for the write tracker (see {@link WriteTracker}). */
  fs?: WriteTrackerFs;
  /** Preflight seams (file-exists + repo-reachable). */
  preflight?: PreflightDeps;
  /** CLAUDE.md generator seams. */
  claudeMd?: GenerateClaudeMdDeps;
  /** ci.yml template loader seams. */
  ciTemplate?: LoadCiTemplateDeps;
}

/**
 * Run the full `claw setup` flow.
 *
 * Flow, in order:
 *   1. Preflight — 4 checks, first failure halts (CHECK 4 skipped if overwrite)
 *   2. Confirmation — hook asks the human to approve the plan
 *   3. Writes — `.claw/config.json`, `.claw/CLAUDE.md`, `.github/workflows/ci.yml`
 *      and the empty `.claw/sessions/` directory. Any failure rolls back
 *      everything written so far.
 *   4. Branch protection — required status checks + admin enforcement
 *   5. Human steps — runners, then the `CLAUDE_CODE_OAUTH_TOKEN` secret
 *
 * The function either resolves cleanly, resolves after the human declines
 * the confirmation (no side effects), or throws a {@link ClawError} with
 * everything rolled back.
 *
 * @param options target + hooks + injected deps
 * @returns `true` on successful completion, `false` when the human declined
 */
export async function runSetup(options: RunSetupOptions): Promise<boolean> {
  const { ref, cwd, overwrite, hooks } = options;
  const octokit = options.deps?.octokit ?? createClient();

  // 1. Preflight
  hooks.onPhase?.("preflight");
  await runPreflight({
    ref,
    cwd,
    overwrite,
    deps: {
      canAccessRepo: options.deps?.preflight?.canAccessRepo ?? canAccessRepoVia(octokit),
      fileExists: options.deps?.preflight?.fileExists,
    },
  });

  // 2. Confirmation — surface the plan, bail out cleanly if the human says no
  const paths = resolveSetupPaths(cwd);
  const plan = buildSetupPlan(ref, overwrite);
  const proceed = await hooks.confirm(plan);
  if (!proceed) {
    return false;
  }

  // 3. Writes — tracked, so we can roll back on ANY downstream failure
  const tracker = new WriteTracker(options.deps?.fs);
  try {
    hooks.onPhase?.("writing-config");
    const config = buildConfig(ref);
    await tracker.writeFile(paths.configJson, serializeConfig(config));
    await tracker.mkdir(paths.sessionsDir);

    hooks.onPhase?.("writing-claude-md");
    const claudeMdContents = await generateClaudeMd({
      cwd,
      deps: options.deps?.claudeMd,
    });
    await tracker.writeFile(paths.claudeMd, claudeMdContents);

    hooks.onPhase?.("writing-ci");
    const ci = await loadCiTemplate({ repo: `${options.ref.owner}/${options.ref.repo}`, deps: options.deps?.ciTemplate });
    await tracker.writeFile(paths.ciYml, ci);

    // 4. Branch protection
    hooks.onPhase?.("branch-protection");
    await configureBranchProtection({ ref, octokit });
  } catch (err) {
    // Always call rollback directly — NEVER via a helper that throws — so
    // we can surface BOTH the original failure AND any rollback leftovers
    // in a single error. Losing the original cause is the worst possible
    // failure mode: the human sees "rollback couldn't delete X" with no
    // clue why setup failed in the first place.
    const rollbackFailures = await tracker.rollback();

    const original = err instanceof ClawError
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

  // 5. Human steps — run AFTER writes, per issue #18's convention
  hooks.onPhase?.("human-steps");
  const humanContext: HumanStepContext = {
    ref,
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    verifyRunnerOnline: async () => hasOnlineRunner({ ref, octokit }),
  };
  await hooks.walkRunnerStep(humanContext);
  await hooks.walkTokenStep(humanContext);

  hooks.onPhase?.("complete");
  return true;
}

/**
 * Assemble the {@link SetupPlan} shown in the confirmation UI.
 *
 * Paths are reported relative to the working directory for display; the
 * absolute equivalents live on the {@link SetupPaths} the orchestrator
 * resolves internally. Exposed so tests can verify the plan matches the
 * file footprint from ARCHITECTURE.md.
 */
export function buildSetupPlan(ref: RepoRef, overwrite: boolean): SetupPlan {
  return {
    ref,
    filesToCreate: [
      ".claw/CLAUDE.md",
      ".claw/config.json",
      ".github/workflows/ci.yml",
    ],
    // Single source of truth — what we show the human must exactly match
    // what we configure on the branch, or the confirmation becomes a lie.
    requiredChecks: [...REQUIRED_STATUS_CHECKS],
    overwrite,
  };
}
