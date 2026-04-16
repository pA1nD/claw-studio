import { describe, it, expect } from "vitest";
import {
  evaluate,
  formatTrackingComment,
  parseTestOutput,
  totalEscalations,
  totalFixCycles,
} from "../../benchmark/evaluate.js";
import { MAX_FIX_ATTEMPTS, WEIGHTS } from "../../benchmark/types.js";
import type { IssueResult, RunResult } from "../../benchmark/types.js";

function issue(partial: Partial<IssueResult> & { number: number; template: number }): IssueResult {
  return {
    title: `issue ${partial.number}`,
    merged: false,
    escalated: false,
    fixCycles: 0,
    ...partial,
  };
}

describe("evaluate – weight invariant", () => {
  it("weights sum to 1.0", () => {
    const sum =
      WEIGHTS.completion + WEIGHTS.correctness + WEIGHTS.efficiency + WEIGHTS.autonomy;
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("evaluate – completion", () => {
  it("perfect completion when every issue merges", () => {
    const issues = [1, 2, 3].map((n) => issue({ number: n, template: n, merged: true }));
    const { completion } = evaluate({
      issues,
      tests: { total: 1, passing: 1 },
    });
    expect(completion).toBe(1);
  });

  it("proportional completion when some escalate", () => {
    const issues = [
      issue({ number: 1, template: 1, merged: true }),
      issue({ number: 2, template: 2, merged: false, escalated: true }),
      issue({ number: 3, template: 3, merged: true }),
    ];
    const { completion } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(completion).toBeCloseTo(2 / 3, 6);
  });

  it("zero issues → completion is 0 (no divide by zero)", () => {
    const { completion } = evaluate({ issues: [], tests: { total: 0, passing: 0 } });
    expect(completion).toBe(0);
  });
});

describe("evaluate – correctness", () => {
  it("perfect when every test passes", () => {
    const { correctness } = evaluate({
      issues: [],
      tests: { total: 10, passing: 10 },
    });
    expect(correctness).toBe(1);
  });

  it("proportional when some tests fail", () => {
    const { correctness } = evaluate({
      issues: [],
      tests: { total: 4, passing: 3 },
    });
    expect(correctness).toBe(0.75);
  });

  it("zero-total tests → correctness is 0 (matches issue contract)", () => {
    const { correctness } = evaluate({
      issues: [issue({ number: 1, template: 1, merged: true })],
      tests: { total: 0, passing: 0 },
    });
    expect(correctness).toBe(0);
  });
});

describe("evaluate – efficiency", () => {
  it("perfect when no fix cycles burn", () => {
    const issues = [1, 2].map((n) =>
      issue({ number: n, template: n, merged: true, fixCycles: 0 }),
    );
    const { efficiency } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(efficiency).toBe(1);
  });

  it("zero when every issue exhausts the max fix budget", () => {
    const issues = [1, 2].map((n) =>
      issue({ number: n, template: n, fixCycles: MAX_FIX_ATTEMPTS }),
    );
    const { efficiency } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(efficiency).toBe(0);
  });

  it("proportional when some fixes burn", () => {
    const issues = [
      issue({ number: 1, template: 1, fixCycles: 1 }),
      issue({ number: 2, template: 2, fixCycles: 0 }),
    ];
    // total_fix = 1, max = 2 * 3 = 6 → 1 - 1/6 = 5/6
    const { efficiency } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(efficiency).toBeCloseTo(5 / 6, 6);
  });
});

describe("evaluate – autonomy", () => {
  it("perfect when nothing escalates", () => {
    const issues = [1, 2, 3].map((n) => issue({ number: n, template: n, merged: true }));
    const { autonomy } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(autonomy).toBe(1);
  });

  it("proportional when some escalate", () => {
    const issues = [
      issue({ number: 1, template: 1, merged: true }),
      issue({ number: 2, template: 2, escalated: true }),
      issue({ number: 3, template: 3, escalated: true }),
    ];
    const { autonomy } = evaluate({ issues, tests: { total: 0, passing: 0 } });
    expect(autonomy).toBeCloseTo(1 / 3, 6);
  });
});

describe("evaluate – composite", () => {
  it("clamps negative composite to 0 (defensive)", () => {
    // Efficiency of -1 is not reachable via public inputs, but the clamp
    // is the contract the evaluator advertises. Simulate via a custom
    // scenario that drives efficiency below 0:
    //   total=1, fixCycles=100 → 1 - 100/3 = -32.33
    const issues = [issue({ number: 1, template: 1, fixCycles: 100 })];
    const { efficiency, composite } = evaluate({
      issues,
      tests: { total: 0, passing: 0 },
    });
    expect(efficiency).toBe(0);
    expect(composite).toBeGreaterThanOrEqual(0);
  });

  it("weighted roll-up matches the documented formula", () => {
    const issues = [
      issue({ number: 1, template: 1, merged: true }),
      issue({ number: 2, template: 2, merged: true, fixCycles: 1 }),
    ];
    const { completion, correctness, efficiency, autonomy, composite } = evaluate({
      issues,
      tests: { total: 10, passing: 8 },
    });
    const expected =
      WEIGHTS.completion * completion +
      WEIGHTS.correctness * correctness +
      WEIGHTS.efficiency * efficiency +
      WEIGHTS.autonomy * autonomy;
    expect(composite).toBeCloseTo(expected, 10);
  });
});

describe("parseTestOutput", () => {
  it("reads vitest default reporter summary", () => {
    const output = `
 ✓ tests/a.test.ts (3)
 ✓ tests/b.test.ts (2)

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  21:32:01
   Duration  1.45s
`;
    expect(parseTestOutput(output)).toEqual({ passing: 5, total: 5 });
  });

  it("reads vitest output with failures", () => {
    const output = `
 FAIL tests/broken.test.ts

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 3 passed (5)
`;
    expect(parseTestOutput(output)).toEqual({ passing: 3, total: 5 });
  });

  it("reads vitest output with skipped mixed in", () => {
    const output = `
      Tests  3 passed | 1 skipped (4)
`;
    expect(parseTestOutput(output)).toEqual({ passing: 3, total: 4 });
  });

  it("reads jest default reporter summary", () => {
    const output = `
Test Suites: 1 passed, 1 total
Tests:       3 passed, 5 total
`;
    expect(parseTestOutput(output)).toEqual({ passing: 3, total: 5 });
  });

  it("reads jest output with failures", () => {
    const output = `
Tests:       2 failed, 3 passed, 5 total
`;
    expect(parseTestOutput(output)).toEqual({ passing: 3, total: 5 });
  });

  it("returns null when no summary line is present", () => {
    expect(parseTestOutput("nothing to see here")).toBeNull();
    expect(parseTestOutput("")).toBeNull();
  });
});

describe("totalFixCycles / totalEscalations", () => {
  it("sums fix cycles across every issue", () => {
    const issues = [
      issue({ number: 1, template: 1, fixCycles: 2 }),
      issue({ number: 2, template: 2, fixCycles: 0 }),
      issue({ number: 3, template: 3, fixCycles: 1 }),
    ];
    expect(totalFixCycles(issues)).toBe(3);
  });

  it("counts escalations", () => {
    const issues = [
      issue({ number: 1, template: 1, escalated: true }),
      issue({ number: 2, template: 2, escalated: false }),
      issue({ number: 3, template: 3, escalated: true }),
    ];
    expect(totalEscalations(issues)).toBe(2);
  });
});

describe("formatTrackingComment", () => {
  it("renders the scoring table from the issue body", () => {
    const result: RunResult = {
      runId: "v0.1-003",
      timestamp: "2026-04-16T22:30:00Z",
      repo: "pA1nD/claw-e2e-mdcast",
      durationSeconds: 3420,
      scores: {
        completion: 1,
        correctness: 0.85,
        efficiency: 0.78,
        autonomy: 1,
        composite: 0.92,
      },
      issues: [
        {
          number: 7,
          template: 1,
          title: "Project scaffold",
          merged: true,
          escalated: false,
          fixCycles: 0,
        },
        {
          number: 8,
          template: 2,
          title: "CLI entry",
          merged: true,
          escalated: false,
          fixCycles: 0,
        },
      ],
    };
    const body = formatTrackingComment(result, { fixCycles: 4, escalations: 0 });
    expect(body).toContain("## Benchmark run v0.1-003");
    expect(body).toContain("| Completion | 1.00 |");
    expect(body).toContain("| Correctness | 0.85 |");
    expect(body).toContain("| Efficiency | 0.78 |");
    expect(body).toContain("| Autonomy | 1.00 |");
    expect(body).toContain("| **Composite** | **0.92** |");
    expect(body).toContain("Duration: 57 min");
    expect(body).toContain("Issues: 2/2 merged");
    expect(body).toContain("Fix cycles: 4 total");
    expect(body).toContain("Escalations: 0");
  });
});
