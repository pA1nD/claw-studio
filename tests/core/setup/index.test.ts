import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { buildSetupPlan, runSetup } from "../../../src/core/setup/index.js";
import type { RunSetupOptions, SetupHooks } from "../../../src/core/setup/index.js";
import { resolveSetupPaths } from "../../../src/core/setup/paths.js";
import { ClawError } from "../../../src/core/types/errors.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };
const cwd = "/tmp/claw-target";

interface ScenarioOverrides {
  confirm?: SetupHooks["confirm"];
  preflightFileExists?: (path: string) => Promise<boolean>;
  canAccessRepo?: () => Promise<boolean>;
  runGenerator?: (prompt: string) => Promise<string>;
  templateContents?: string;
  updateBranchProtectionBehavior?: () => Promise<{ data: Record<string, unknown> }>;
  listRunnersBehavior?: () => Promise<{ data: { total_count: number; runners: unknown[] } }>;
}

interface Scenario {
  writes: Map<string, string>;
  mkdirs: string[];
  removed: string[];
  runSetup: () => Promise<boolean>;
  hooks: SetupHooks;
  runnerStepCalls: number;
  tokenStepCalls: number;
  phases: string[];
}

/** Build a fully-mocked scenario that drives `runSetup` end-to-end. */
function buildScenario(overrides: ScenarioOverrides = {}): Scenario {
  const writes = new Map<string, string>();
  const mkdirs: string[] = [];
  const removed: string[] = [];
  const phases: string[] = [];
  let runnerStepCalls = 0;
  let tokenStepCalls = 0;

  const paths = resolveSetupPaths(cwd);
  const canAccessRepo = overrides.canAccessRepo ?? (async () => true);
  const preflightFileExists =
    overrides.preflightFileExists ??
    (async (path: string) => {
      // Required files exist, claw files don't.
      if (path.endsWith("README.md")) return true;
      if (path.endsWith("ROADMAP.md")) return true;
      if (path === paths.claudeMd) return false;
      if (path === paths.configJson) return false;
      if (path === paths.ciYml) return false;
      return false;
    });
  const runGenerator =
    overrides.runGenerator ?? (async () => "# Generated CLAUDE.md\n\nBe specific.");
  const templateContents = overrides.templateContents ?? "name: CI\n";

  const updateBranchProtection = vi.fn(
    overrides.updateBranchProtectionBehavior ??
      (async () => ({ data: { url: "protection" } })),
  );
  const reposGet = vi.fn(async () => ({ data: { default_branch: "main" } }));
  const listSelfHostedRunnersForRepo = vi.fn(
    overrides.listRunnersBehavior ??
      (async () => ({ data: { total_count: 1, runners: [{ name: "r", status: "online", busy: false }] } })),
  );

  const octokit = {
    repos: {
      get: reposGet,
      updateBranchProtection,
    },
    actions: {
      listSelfHostedRunnersForRepo,
    },
  } as unknown as Octokit;

  const hooks: SetupHooks = {
    confirm: overrides.confirm ?? (async () => true),
    walkRunnerStep: async (context) => {
      runnerStepCalls += 1;
      if (context.verifyRunnerOnline) {
        // Exercise the verify path once per run.
        await context.verifyRunnerOnline();
      }
    },
    walkTokenStep: async () => {
      tokenStepCalls += 1;
    },
    onPhase: (phase) => {
      phases.push(phase);
    },
  };

  const options: RunSetupOptions = {
    ref,
    cwd,
    overwrite: false,
    hooks,
    deps: {
      octokit,
      fs: {
        writeFile: async (path: string, content: string) => {
          writes.set(path, content);
        },
        mkdir: async (path: string) => {
          mkdirs.push(path);
        },
        rm: async (path: string) => {
          removed.push(path);
        },
      },
      preflight: {
        canAccessRepo,
        fileExists: preflightFileExists,
      },
      claudeMd: {
        readFile: async (path: string) => {
          if (path.endsWith("README.md")) return "readme source";
          if (path.endsWith("ROADMAP.md")) return "roadmap source";
          throw new Error(`unexpected read: ${path}`);
        },
        runGenerator,
      },
      ciTemplate: {
        resolveTemplatePath: () => "/fake/templates/ci.yml",
        readFile: async () => templateContents,
      },
    },
  };

  return {
    writes,
    mkdirs,
    removed,
    runSetup: () => runSetup(options),
    hooks,
    get runnerStepCalls() {
      return runnerStepCalls;
    },
    get tokenStepCalls() {
      return tokenStepCalls;
    },
    phases,
  };
}

describe("buildSetupPlan", () => {
  it("reports the three files in the canonical footprint", () => {
    const plan = buildSetupPlan(ref, false);
    expect(plan.filesToCreate).toEqual([
      ".claw/CLAUDE.md",
      ".claw/config.json",
      ".github/workflows/ci.yml",
    ]);
  });

  it("reports the four required checks", () => {
    const plan = buildSetupPlan(ref, false);
    expect(plan.requiredChecks).toEqual([
      "Lint",
      "Type Check",
      "Tests",
      "Review Summary",
    ]);
  });

  it("mirrors the overwrite flag", () => {
    expect(buildSetupPlan(ref, true).overwrite).toBe(true);
    expect(buildSetupPlan(ref, false).overwrite).toBe(false);
  });
});

describe("runSetup — happy path", () => {
  it("writes all three files, creates sessions/, sets protection, runs human steps", async () => {
    const scenario = buildScenario();
    const completed = await scenario.runSetup();

    expect(completed).toBe(true);

    const paths = resolveSetupPaths(cwd);
    expect(scenario.writes.has(paths.configJson)).toBe(true);
    expect(scenario.writes.has(paths.claudeMd)).toBe(true);
    expect(scenario.writes.has(paths.ciYml)).toBe(true);
    expect(scenario.mkdirs).toContain(paths.sessionsDir);

    // config.json is valid JSON with the expected fields
    const raw = scenario.writes.get(paths.configJson);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? "") as Record<string, unknown>;
    expect(parsed["repo"]).toBe("pA1nD/claw-studio");
    expect(parsed["clawVersion"]).toBe("0.0.1");
    expect(parsed["pollInterval"]).toBe(60);

    // Both human steps fired, in order
    expect(scenario.runnerStepCalls).toBe(1);
    expect(scenario.tokenStepCalls).toBe(1);

    // Phases emitted in the expected order
    expect(scenario.phases).toEqual([
      "preflight",
      "writing-config",
      "writing-claude-md",
      "writing-ci",
      "branch-protection",
      "human-steps",
      "complete",
    ]);
  });

  it("returns false and writes nothing when the human declines the confirmation", async () => {
    const scenario = buildScenario({ confirm: async () => false });
    const completed = await scenario.runSetup();
    expect(completed).toBe(false);
    expect(scenario.writes.size).toBe(0);
    expect(scenario.mkdirs).toEqual([]);
    expect(scenario.runnerStepCalls).toBe(0);
    expect(scenario.tokenStepCalls).toBe(0);
  });
});

describe("runSetup — preflight failures", () => {
  it("halts before writing when preflight fails", async () => {
    const scenario = buildScenario({ canAccessRepo: async () => false });
    await expect(scenario.runSetup()).rejects.toBeInstanceOf(ClawError);
    expect(scenario.writes.size).toBe(0);
    expect(scenario.runnerStepCalls).toBe(0);
  });
});

describe("runSetup — rollback", () => {
  it("rolls back every file written so far when branch protection fails", async () => {
    const scenario = buildScenario({
      updateBranchProtectionBehavior: async () => {
        throw new Error("403 Forbidden");
      },
    });

    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);

    const paths = resolveSetupPaths(cwd);
    // Everything that was written earlier in the flow must be removed.
    expect(scenario.removed).toContain(paths.configJson);
    expect(scenario.removed).toContain(paths.sessionsDir);
    expect(scenario.removed).toContain(paths.claudeMd);
    expect(scenario.removed).toContain(paths.ciYml);
  });

  it("rolls back when CLAUDE.md generation fails mid-flight", async () => {
    const scenario = buildScenario({
      runGenerator: async () => {
        throw new Error("claude crashed");
      },
    });

    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);

    const paths = resolveSetupPaths(cwd);
    // config.json and sessions/ had already been written, so they must be removed.
    expect(scenario.removed).toContain(paths.configJson);
    expect(scenario.removed).toContain(paths.sessionsDir);
    // CLAUDE.md never got written, so rollback doesn't touch it.
    expect(scenario.removed).not.toContain(paths.claudeMd);
  });

  it("does NOT run human steps when a write or protection call fails", async () => {
    const scenario = buildScenario({
      updateBranchProtectionBehavior: async () => {
        throw new Error("403");
      },
    });
    await scenario.runSetup().catch(() => undefined);
    expect(scenario.runnerStepCalls).toBe(0);
    expect(scenario.tokenStepCalls).toBe(0);
  });
});

describe("runSetup — verifyRunnerOnline wiring", () => {
  it("gives the runner step a working verifier that hits the Actions API", async () => {
    const scenario = buildScenario();
    await scenario.runSetup();
    expect(scenario.runnerStepCalls).toBe(1);
  });
});
