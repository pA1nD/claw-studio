/**
 * Typed errors used across Claw Studio.
 *
 * Every error surfaces to the human using the standard format defined in
 * CLAUDE.md:
 *
 *     [CLAW] Stopped — {what is wrong}
 *     {what to look at or do}
 *     Run `claw status` to re-check once resolved.
 *
 * `message` is the first line (what is wrong).
 * `hint` is the optional second line (what to look at or do).
 */
export class ClawError extends Error {
  /** Short instruction describing what the human should do next. */
  public readonly hint?: string;

  /**
   * Create a ClawError.
   * @param message short description of what went wrong
   * @param hint optional single-line instruction for recovery
   */
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ClawError";
    this.hint = hint;
  }
}

/**
 * Type guard for ClawError.
 * @param value value to test
 * @returns true if `value` is an instance of ClawError
 */
export function isClawError(value: unknown): value is ClawError {
  return value instanceof ClawError;
}
