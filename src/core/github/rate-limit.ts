import { ClawError } from "../types/errors.js";

/**
 * Detect a GitHub rate-limit response.
 *
 * GitHub returns `429 Too Many Requests` for secondary rate limits and
 * `403 Forbidden` with `X-RateLimit-Remaining: 0` for the primary one —
 * both callers (the inspector and the implementation agent) must recognise
 * both shapes so the loop halts cleanly instead of crashing with an
 * unformatted exception.
 *
 * @param err an unknown error thrown by an Octokit call
 * @returns true when the error represents a GitHub rate-limit response
 */
export function isRateLimitError(err: unknown): boolean {
  const status = readNumberProp(err, "status");
  if (status !== 403 && status !== 429) return false;
  if (status === 429) return true;
  const remaining = readResponseHeader(err, "x-ratelimit-remaining");
  return remaining !== undefined && Number(remaining) === 0;
}

/**
 * Format a rate-limit error into the standard `[CLAW] Stopped` shape.
 *
 * The reset timestamp (from the `x-ratelimit-reset` header) is surfaced in
 * the hint when the response carries one — otherwise the hint falls back to
 * the generic "re-check" message so the human is never left without
 * actionable guidance.
 *
 * @param err the rate-limit error from Octokit
 * @returns a ClawError in the standard two-line format
 */
export function toRateLimitClawError(err: unknown): ClawError {
  const resetSeconds = Number(readResponseHeader(err, "x-ratelimit-reset"));
  const hint = Number.isFinite(resetSeconds)
    ? `Limit resets at ${new Date(resetSeconds * 1000).toISOString()}. Run \`claw status\` to re-check once resolved.`
    : "Run `claw status` to re-check once resolved.";
  return new ClawError("GitHub API rate limit reached.", hint);
}

/**
 * Run `fn` and translate any rate-limit error it surfaces into a
 * {@link ClawError}. Non-rate-limit errors propagate unchanged so real
 * failures are never silently re-labelled.
 *
 * Used by both the state inspector and the implementation agent to keep the
 * "GitHub API rate limit reached." surface consistent across the codebase.
 *
 * @param fn the async operation that makes GitHub API calls
 * @returns whatever `fn` returns
 * @throws {ClawError} formatted rate-limit error on 429/403+remaining=0
 */
export async function withRateLimitHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      throw toRateLimitClawError(err);
    }
    throw err;
  }
}

/** Read `err[key]` when it is a number, or `undefined`. */
export function readNumberProp(err: unknown, key: string): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const val = (err as Record<string, unknown>)[key];
  return typeof val === "number" ? val : undefined;
}

/** Read `err.response.headers[key]` when it is a string, or `undefined`. */
export function readResponseHeader(err: unknown, key: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return undefined;
  const headers = (response as Record<string, unknown>).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const val = (headers as Record<string, unknown>)[key];
  return typeof val === "string" ? val : undefined;
}
