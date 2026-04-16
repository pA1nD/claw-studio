/**
 * Shared types and constants for the Claw Studio end-to-end benchmark
 * (issue #31). Every module under `benchmark/` imports from here so the
 * scoring shape, the run-id format, and the weights live in exactly one
 * place.
 */

/**
 * Maximum fix attempts per issue — mirrors the orchestrator's escalation
 * threshold. Used by the efficiency score to normalise against the
 * theoretical worst case (every issue burns every fix).
 */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * The composite score weights from the issue body. Sum to 1.0 by design.
 * Tests assert the invariant so accidental drift is caught at compile time
 * of the test file (not silently in production).
 */
export const WEIGHTS = {
  completion: 0.4,
  correctness: 0.3,
  efficiency: 0.15,
  autonomy: 0.15,
} as const;

/** Run label format — `{milestone}-{NNN}` with zero-padded iteration counter. */
export const ITERATION_PAD = 3;

/** Structured representation of a run identifier like `v0.1-003`. */
export interface RunId {
  /** The product milestone being benchmarked, e.g. `"v0.1"`. */
  readonly milestone: string;
  /** The monotonically-incrementing iteration counter. */
  readonly iteration: number;
  /** The rendered label (e.g. `"v0.1-003"`) — also the GitHub label name. */
  readonly label: string;
}

/** Result for a single copied template issue. */
export interface IssueResult {
  /** Issue number in the benchmark repo. */
  number: number;
  /** The template source rank (1..6 for mdcast) the issue was copied from. */
  template: number;
  /** The issue title (preserved from the template). */
  title: string;
  /** True when the PR for this issue was squash-merged and the issue closed. */
  merged: boolean;
  /** Number of fix cycles the loop ran — read from the loop's session files. */
  fixCycles: number;
  /** True when the issue carries the `needs-human` label at run end. */
  escalated: boolean;
}

/** The four weighted scores + the composite roll-up. */
export interface ScoreCard {
  /** `(issues merged) / (total issues)` — weighted 0.4. */
  completion: number;
  /** `(tests passing) / (total tests)` — weighted 0.3. */
  correctness: number;
  /** `1 - total_fix_cycles / (total_issues * MAX_FIX_ATTEMPTS)` — weighted 0.15. */
  efficiency: number;
  /** `1 - escalated / total_issues` — weighted 0.15. */
  autonomy: number;
  /** Weighted sum clamped to [0, 1]. */
  composite: number;
}

/** Test totals parsed from `npm test` output. */
export interface TestTotals {
  /** Total number of test cases detected. */
  total: number;
  /** Number of cases that passed. */
  passing: number;
}

/** A full benchmark run record — serialised to `~/.claw-bench/results/<runId>.json`. */
export interface RunResult {
  /** Run label (e.g. `"v0.1-003"`). */
  runId: string;
  /** ISO-8601 timestamp of when the run completed. */
  timestamp: string;
  /** `owner/repo` the benchmark targeted. */
  repo: string;
  /** Wall-clock duration of the loop in seconds. */
  durationSeconds: number;
  /** The four scores plus composite. */
  scores: ScoreCard;
  /** Per-issue outcomes in template order. */
  issues: IssueResult[];
}
