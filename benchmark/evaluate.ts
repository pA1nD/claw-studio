/**
 * Pure scoring logic for the Claw Studio benchmark (issue #31).
 *
 * No disk I/O, no GitHub calls — the evaluator takes the observations
 * collected by the harness and maps them to a {@link ScoreCard}. Kept pure
 * so every edge case (zero issues, zero tests, every issue escalated)
 * round-trips through a vitest table without a spawned child process.
 */
import type { IssueResult, RunResult, ScoreCard, TestTotals } from "./types.js";
import { MAX_FIX_ATTEMPTS, WEIGHTS } from "./types.js";

/** Input for {@link evaluate} — one struct so new scores can be added later. */
export interface EvaluateInput {
  /** Per-issue outcomes — one entry per copied template issue. */
  issues: readonly IssueResult[];
  /** Total + passing test counts from `npm test` on the final main. */
  tests: TestTotals;
}

/**
 * Compute the {@link ScoreCard} from a set of per-issue outcomes and test
 * results. The weights are pulled from {@link WEIGHTS} so a future tweak
 * to the scoring contract is a single-line change.
 *
 * Division-by-zero guards:
 *   - 0 issues → completion = 0, efficiency = 1, autonomy = 1
 *   - 0 tests  → correctness = 0 (matches the issue text: "If `npm test`
 *     itself fails to run (no package.json, broken config), correctness
 *     = 0.")
 *
 * @param input  per-issue outcomes + test totals
 * @returns the five-number score card
 */
export function evaluate(input: EvaluateInput): ScoreCard {
  const total = input.issues.length;
  const merged = input.issues.filter((i) => i.merged).length;
  const escalated = input.issues.filter((i) => i.escalated).length;
  const totalFix = input.issues.reduce((sum, i) => sum + i.fixCycles, 0);

  const completion = total === 0 ? 0 : merged / total;
  const correctness =
    input.tests.total === 0 ? 0 : input.tests.passing / input.tests.total;
  const efficiency =
    total === 0 ? 1 : 1 - totalFix / (total * MAX_FIX_ATTEMPTS);
  const autonomy = total === 0 ? 1 : 1 - escalated / total;

  const composite =
    WEIGHTS.completion * completion +
    WEIGHTS.correctness * correctness +
    WEIGHTS.efficiency * efficiency +
    WEIGHTS.autonomy * autonomy;

  return {
    completion: clampUnit(completion),
    correctness: clampUnit(correctness),
    efficiency: clampUnit(efficiency),
    autonomy: clampUnit(autonomy),
    composite: clampUnit(composite),
  };
}

/**
 * Format the tracking-issue comment body for a run. The shape matches the
 * table shown in the issue so a reader can scan every run's outcome in
 * the same visual columns.
 *
 * @param result  the full run record
 * @param totals  total fix cycles + total escalations (computed by the caller)
 * @returns the markdown comment body
 */
export function formatTrackingComment(
  result: RunResult,
  totals: { fixCycles: number; escalations: number },
): string {
  const merged = result.issues.filter((i) => i.merged).length;
  const durationMinutes = Math.round(result.durationSeconds / 60);
  const total = result.issues.length;
  const { scores } = result;

  return [
    `## Benchmark run ${result.runId}`,
    ``,
    `| Metric | Score |`,
    `|---|---|`,
    `| Completion | ${formatScore(scores.completion)} |`,
    `| Correctness | ${formatScore(scores.correctness)} |`,
    `| Efficiency | ${formatScore(scores.efficiency)} |`,
    `| Autonomy | ${formatScore(scores.autonomy)} |`,
    `| **Composite** | **${formatScore(scores.composite)}** |`,
    ``,
    `Duration: ${durationMinutes} min | Issues: ${merged}/${total} merged | Fix cycles: ${totals.fixCycles} total | Escalations: ${totals.escalations}`,
    ``,
  ].join("\n");
}

/**
 * Parse `npm test` output to extract total + passing test counts.
 *
 * Supports the two reporters the benchmark target is likely to emit:
 *   - **vitest default** — `Tests  2 failed | 3 passed (5)` — read failed +
 *     passed + total.
 *   - **jest default** — `Tests:       3 passed, 5 total` — read passed +
 *     total directly.
 *
 * When no recognised line is found, returns `null`. The harness maps
 * `null` to `{ total: 0, passing: 0 }`, which produces a correctness score
 * of 0 per the issue's "npm test itself fails to run" clause.
 *
 * @param output  combined stdout + stderr of `npm test`
 * @returns parsed totals, or `null` when nothing matched
 */
export function parseTestOutput(output: string): TestTotals | null {
  // Vitest default reporter: "Tests  2 failed | 3 passed (5)"
  // `skipped` and `todo` also appear in Vitest output; include them as a
  // defensive choice so a `3 passed | 1 skipped (4)` line is read as
  // "3/4 pass rate", not "3/3".
  const vitest = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*\d+\s+\w+)*\s*\((\d+)\)/.exec(
    output,
  );
  if (vitest) {
    const passing = parseIntOrZero(vitest[2]);
    const total = parseIntOrZero(vitest[3]);
    return { passing, total };
  }

  // Jest default reporter: "Tests:       3 passed, 5 total" (or with failures)
  const jest = /Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/.exec(
    output,
  );
  if (jest) {
    const passing = parseIntOrZero(jest[2]);
    const total = parseIntOrZero(jest[3]);
    return { passing, total };
  }

  return null;
}

/** Total fix cycles across every issue. */
export function totalFixCycles(issues: readonly IssueResult[]): number {
  return issues.reduce((sum, i) => sum + i.fixCycles, 0);
}

/** Number of issues that ended the run escalated to a human. */
export function totalEscalations(issues: readonly IssueResult[]): number {
  return issues.reduce((sum, i) => sum + (i.escalated ? 1 : 0), 0);
}

/** Clamp a number into the unit interval `[0, 1]`, mapping NaN/Infinity to 0. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Render a score to two decimal places for the markdown comment. */
function formatScore(value: number): string {
  return value.toFixed(2);
}

/** Parse `value` as an integer, returning 0 for undefined / NaN. */
function parseIntOrZero(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
