import { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";

/**
 * Dependencies injected into {@link createClient}.
 *
 * These exist so tests can exercise the error path and verify what token was
 * passed to Octokit without reaching into `process.env` or the real Octokit
 * constructor.
 */
export interface CreateClientDeps {
  /** Returns the PAT, or `undefined` when it is not set. Defaults to reading `GITHUB_PAT`. */
  readToken?: () => string | undefined;
  /** Factory used to construct the Octokit instance. Defaults to `new Octokit(...)`. */
  OctokitCtor?: new (options: { auth: string }) => Octokit;
}

/**
 * Create an authenticated Octokit client.
 *
 * This is the **only** place in the codebase that talks to the GitHub auth
 * layer. Every other module must import `createClient()` rather than
 * constructing Octokit directly, so the auth strategy can evolve in one file:
 *
 *   - **v0.1** — PAT via the `GITHUB_PAT` env variable (this implementation).
 *   - **v0.3+** — GitHub App OAuth: swap `authStrategy` for `@octokit/auth-app`.
 *   - **Self-hosted** — device flow: swap for `@octokit/auth-oauth-device`.
 *
 * In each case, callers keep importing `createClient()` and nothing else
 * changes. That is the whole point of this module.
 *
 * @param deps optional injected dependencies for testing
 * @returns an authenticated Octokit client
 * @throws {ClawError} when `GITHUB_PAT` is missing or empty
 */
export function createClient(deps: CreateClientDeps = {}): Octokit {
  const readToken = deps.readToken ?? defaultReadToken;
  const OctokitCtor = deps.OctokitCtor ?? Octokit;

  const token = readToken()?.trim();
  if (token === undefined || token.length === 0) {
    // Caught both "unset" and "whitespace-only" here so a paste error or a
    // trailing newline from a secrets manager surfaces as the friendly
    // `[CLAW] Stopped` error, not a silent 401 on the first API call.
    throw new ClawError(
      "GITHUB_PAT is not set.",
      "Add GITHUB_PAT to your .env file. See .env.example for the required format.",
    );
  }

  return new OctokitCtor({ auth: token });
}

/** Default token reader: reads `GITHUB_PAT` from `process.env`. */
function defaultReadToken(): string | undefined {
  return process.env.GITHUB_PAT;
}
