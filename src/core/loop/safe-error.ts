import { ClawError, isClawError } from "../types/errors.js";

/**
 * Convert any thrown value into a {@link ClawError} without leaking sensitive
 * data — most importantly the `Authorization` header that Octokit's
 * `RequestError` carries on `request.headers.authorization`.
 *
 * Why this matters: a raw Octokit error includes `request.headers` with the
 * PAT under `authorization`. Anywhere the orchestrator prints, logs, or
 * serializes a thrown value, the token would surface — terminals, log files,
 * crash dumps. This wrapper extracts only the `message` string and discards
 * everything else (`request`, `response`, `headers`, `data`).
 *
 * Mirrors the security carry-forward flagged by the Security review on PR #27
 * and PR #28: "the orchestrator in issue #7 must use `err.message` (or
 * `ClawError.message`) for rendering and never serialize the full error
 * object."
 *
 * @param err any thrown value
 * @returns a {@link ClawError} carrying only safe message text
 */
export function toClawError(err: unknown): ClawError {
  if (isClawError(err)) return err;
  if (err instanceof Error) {
    // Octokit's `RequestError.message` is just the verb + url + status —
    // never the auth header. Reading only the message keeps tokens out of
    // logs and terminal scrollback.
    const message = err.message.length > 0 ? err.message : "unexpected error.";
    return new ClawError(message);
  }
  return new ClawError("unexpected error.");
}
