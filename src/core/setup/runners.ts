import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";

/** A subset of the GitHub Actions runner fields that the setup flow cares about. */
export interface RunnerSummary {
  /** Human-readable name the runner registered with. */
  name: string;
  /** True when GitHub can reach the runner. */
  online: boolean;
  /** True when the runner is not currently executing a job. */
  idle: boolean;
}

/** Options for {@link listRunners}. */
export interface ListRunnersOptions {
  /** Target repository. */
  ref: RepoRef;
  /** Authenticated Octokit (from `createClient()`). */
  octokit: Pick<Octokit, "actions">;
}

/**
 * List self-hosted runners registered to `ref`.
 *
 * The result is a small, stable projection — `@octokit/rest` evolves its
 * response type frequently and we want the runner verification UI to keep
 * working across upgrades.
 *
 * @throws {ClawError} when the runners endpoint cannot be queried
 */
export async function listRunners(
  options: ListRunnersOptions,
): Promise<RunnerSummary[]> {
  const { ref, octokit } = options;
  try {
    const { data } = await octokit.actions.listSelfHostedRunnersForRepo({
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    const runners = data.runners ?? [];
    return runners.map((runner) => ({
      name: String(runner.name),
      online: Boolean(runner.status === "online"),
      idle: Boolean(runner.busy === false),
    }));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not list self-hosted runners for ${ref.owner}/${ref.repo}.`,
      `Check that your PAT has admin access to the repo. Underlying error: ${detail}`,
    );
  }
}

/**
 * Return true when `ref` has at least one self-hosted runner in the `online`
 * state — regardless of whether it is currently idle or busy.
 *
 * @param options same as {@link listRunners}
 */
export async function hasOnlineRunner(
  options: ListRunnersOptions,
): Promise<boolean> {
  const runners = await listRunners(options);
  return runners.some((runner) => runner.online);
}
