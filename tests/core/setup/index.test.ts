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
  yes?: boolean;
  skipRunners?: boolean;
  runnerCount?: number;
  preflightFileExists?: (path: string) => Promise<boolean>;
  canAccessRepo?: () => Promise<boolean>;
  runGenerator?: (prompt: string) => Promise<string>;
  templateContents?: string;
  updateBranchProtectionBehavior?: () => Promise<{ data: Record<string, unknown> }>;
  pushSecretEncrypt?: (value: string, publicKey: string) => Promise<string>;
  composeUpBehavior?: () => Promise<void>;
  dockerAvailable?: () => Promise<boolean>;
  pollOnline?: () => Promise<boolean>;
  getRepoPublicKeyBehavior?: () => Promise<{ data: { key: string; key_id: string } }>;
  createOrUpdateRepoSecretBehavior?: () => Promise<{ data: Record<string, unknown> }>;
  createRegistrationTokenBehavior?: () => Promise<{ data: { token: string } }>;
  rmBehavior?: (path: string) => Promise<void>;
  envFileRead?: (path: string) => Promise<string | null>;
  /** Tokens passed via CLI flags — override env + env file. */
  tokens?: RunSetupOptions["tokens"];
  /** Fake process env for the resolver — defaults to GITHUB_PAT + Claude token present. */
  readEnv?: (key: string) => string | undefined;
}

interface Scenario {
  writes: Map<string, string>;
  mkdirs: string[];
  removed: string[];
  runSetup: () => Promise<boolean>;
  phases: string[];
  /** What was passed to `createOrUpdateRepoSecret`. */
  pushedSecret: { name?: string; cipher?: string; key_id?: string };
  composeUpCalls: string[];
}

/** Build a fully-mocked scenario that drives `runSetup` end-to-end. */
function buildScenario(overrides: ScenarioOverrides = {}): Scenario {
  const writes = new Map<string, string>();
  const mkdirs: string[] = [];
  const removed: string[] = [];
  const phases: string[] = [];
  const composeUpCalls: string[] = [];
  const pushedSecret: { name?: string; cipher?: string; key_id?: string } = {};

  const paths = resolveSetupPaths(cwd);
  const canAccessRepo = overrides.canAccessRepo ?? (async () => true);
  const skipRunners = overrides.skipRunners ?? false;

  const preflightFileExists =
    overrides.preflightFileExists ??
    (async (path: string) => {
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
  const envFileRead = overrides.envFileRead ?? (async () => null);

  const updateBranchProtection = vi.fn(
    overrides.updateBranchProtectionBehavior ??
      (async () => ({ data: { url: "protection" } })),
  );
  const reposGet = vi.fn(async () => ({ data: { default_branch: "main" } }));
  const getRepoPublicKey = vi.fn(
    overrides.getRepoPublicKeyBehavior ??
      (async () => ({
        data: { key: "dGVzdC1wdWJsaWMta2V5", key_id: "key-1" },
      })),
  );
  const createOrUpdateRepoSecret = vi.fn(
    overrides.createOrUpdateRepoSecretBehavior ??
      (async (args: Record<string, unknown>) => {
        pushedSecret.name = String(args["secret_name"]);
        pushedSecret.cipher = String(args["encrypted_value"]);
        pushedSecret.key_id = String(args["key_id"]);
        return { data: {} };
      }),
  );
  const createRegistrationTokenForRepo = vi.fn(
    overrides.createRegistrationTokenBehavior ??
      (async () => ({ data: { token: "runner-reg-token" } })),
  );
  const listSelfHostedRunnersForRepo = vi.fn(async () => ({
    data: {
      total_count: 1,
      runners: [{ name: "r", status: "online", busy: false }],
    },
  }));

  const octokit = {
    repos: { get: reposGet, updateBranchProtection },
    actions: {
      listSelfHostedRunnersForRepo,
      getRepoPublicKey,
      createOrUpdateRepoSecret,
      createRegistrationTokenForRepo,
    },
  } as unknown as Octokit;

  const hooks: SetupHooks = {
    confirm: overrides.confirm ?? (async () => true),
    onPhase: (phase) => {
      phases.push(phase);
    },
  };

  const options: RunSetupOptions = {
    ref,
    cwd,
    overwrite: false,
    yes: overrides.yes,
    skipRunners,
    runnerCount: overrides.runnerCount,
    tokens: overrides.tokens,
    hooks,
    deps: {
      makeOctokit: () => octokit,
      fs: {
        writeFile: async (path: string, content: string) => {
          writes.set(path, content);
        },
        mkdir: async (path: string) => {
          mkdirs.push(path);
        },
        rm: async (path: string) => {
          removed.push(path);
          if (overrides.rmBehavior) await overrides.rmBehavior(path);
        },
      },
      preflight: { canAccessRepo, fileExists: preflightFileExists },
      tokens: {
        readEnv:
          overrides.readEnv ??
          ((key: string) => {
            if (key === "GITHUB_PAT") return "ghp_test_pat";
            if (key === "CLAUDE_CODE_OAUTH_TOKEN") return "clm_test_token";
            return undefined;
          }),
      },
      envFile: {
        readFile: envFileRead,
        writeFile: async (path: string, content: string) => {
          writes.set(path, content);
        },
        mkdir: async (path: string) => {
          mkdirs.push(path);
        },
        chmod: async () => {},
      },
      gitignore: {
        readFile: async () => null,
        writeFile: async (path: string, content: string) => {
          writes.set(path, content);
        },
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
      secret: {
        encrypt:
          overrides.pushSecretEncrypt ?? (async (value: string) => `enc(${value})`),
      },
      runnerCompose: {
        writeFile: async (path: string, content: string) => {
          writes.set(path, content);
        },
        mkdir: async (path: string) => {
          mkdirs.push(path);
        },
      },
      runners: {
        dockerAvailable: overrides.dockerAvailable ?? (async () => true),
        composeUp:
          overrides.composeUpBehavior ??
          (async (path: string) => {
            composeUpCalls.push(path);
          }),
        pollOnline: overrides.pollOnline ?? (async () => true),
        sleep: async () => {},
        now: () => Date.now(),
      },
    },
  };

  return {
    writes,
    mkdirs,
    removed,
    runSetup: () => runSetup(options),
    phases,
    pushedSecret,
    composeUpCalls,
  };
}

describe("buildSetupPlan", () => {
  it("includes .claw/.env, compose file, and the four canonical artefacts", () => {
    const plan = buildSetupPlan(ref, false);
    expect(plan.filesToCreate).toEqual([
      ".claw/.env",
      ".claw/CLAUDE.md",
      ".claw/config.json",
      ".github/workflows/ci.yml",
      ".claw/runners/docker-compose.yml",
    ]);
  });

  it("drops the compose file from the plan when skipRunners is true", () => {
    const plan = buildSetupPlan(ref, false, { skipRunners: true });
    expect(plan.filesToCreate).not.toContain(".claw/runners/docker-compose.yml");
    expect(plan.skipRunners).toBe(true);
    expect(plan.runnerCount).toBe(0);
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

  it("defaults runnerCount to 6 when skipRunners is false", () => {
    expect(buildSetupPlan(ref, false).runnerCount).toBe(6);
  });

  it("respects an explicit runner count override", () => {
    expect(buildSetupPlan(ref, false, { runnerCount: 12 }).runnerCount).toBe(12);
  });
});

describe("runSetup — happy path", () => {
  it("writes every artefact, pushes the secret, starts runners", async () => {
    const scenario = buildScenario();
    const completed = await scenario.runSetup();

    expect(completed).toBe(true);

    const paths = resolveSetupPaths(cwd);
    expect(scenario.writes.has(paths.envFile)).toBe(true);
    expect(scenario.writes.has(paths.configJson)).toBe(true);
    expect(scenario.writes.has(paths.claudeMd)).toBe(true);
    expect(scenario.writes.has(paths.ciYml)).toBe(true);
    expect(scenario.writes.has(paths.composeFile)).toBe(true);
    expect(scenario.writes.has(paths.gitignore)).toBe(true);
    expect(scenario.mkdirs).toContain(paths.sessionsDir);

    const envContents = scenario.writes.get(paths.envFile) ?? "";
    expect(envContents).toContain("GITHUB_PAT=ghp_test_pat");
    expect(envContents).toContain("CLAUDE_CODE_OAUTH_TOKEN=clm_test_token");

    const configRaw = scenario.writes.get(paths.configJson) ?? "";
    const parsed = JSON.parse(configRaw) as Record<string, unknown>;
    expect(parsed["repo"]).toBe("pA1nD/claw-studio");
    expect(parsed["clawVersion"]).toBe("0.0.1");
    expect(parsed["pollInterval"]).toBe(60);
    expect(parsed["runnerCount"]).toBe(6);

    expect(scenario.pushedSecret.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(scenario.pushedSecret.cipher).toBe("enc(clm_test_token)");
    expect(scenario.pushedSecret.key_id).toBe("key-1");

    expect(scenario.composeUpCalls).toEqual([paths.composeFile]);

    expect(scenario.phases).toEqual([
      "preflight",
      "resolving-tokens",
      "writing-env",
      "writing-config",
      "writing-gitignore",
      "writing-claude-md",
      "writing-ci",
      "branch-protection",
      "pushing-secret",
      "starting-runners",
      "complete",
    ]);
  });

  it("returns false and writes nothing when the human declines", async () => {
    const scenario = buildScenario({ confirm: async () => false });
    const completed = await scenario.runSetup();
    expect(completed).toBe(false);
    expect(scenario.writes.size).toBe(0);
    expect(scenario.mkdirs).toEqual([]);
  });

  it("bypasses the confirm hook when yes is true", async () => {
    const confirm = vi.fn(async () => false);
    const scenario = buildScenario({ yes: true, confirm });
    const completed = await scenario.runSetup();
    expect(completed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips runner provisioning when skipRunners is true", async () => {
    const scenario = buildScenario({ skipRunners: true });
    const completed = await scenario.runSetup();
    expect(completed).toBe(true);
    const paths = resolveSetupPaths(cwd);
    expect(scenario.writes.has(paths.composeFile)).toBe(false);
    expect(scenario.composeUpCalls).toEqual([]);
    expect(scenario.phases).not.toContain("starting-runners");
  });

  it("honours the runner-count override in config.json and compose file", async () => {
    const scenario = buildScenario({ runnerCount: 3 });
    await scenario.runSetup();
    const paths = resolveSetupPaths(cwd);
    const configRaw = scenario.writes.get(paths.configJson) ?? "";
    const parsed = JSON.parse(configRaw) as Record<string, unknown>;
    expect(parsed["runnerCount"]).toBe(3);
    const compose = scenario.writes.get(paths.composeFile) ?? "";
    expect(compose).toContain("claw-runner-1:");
    expect(compose).toContain("claw-runner-3:");
    expect(compose).not.toContain("claw-runner-4:");
  });
});

describe("runSetup — token resolution", () => {
  it("halts when no token is available from any source", async () => {
    const scenario = buildScenario({ readEnv: () => undefined });
    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("GITHUB_PAT is not set.");
    // Nothing should have been written before token resolution failed.
    expect(scenario.writes.size).toBe(0);
  });

  it("accepts CLI flag tokens as the highest-priority source", async () => {
    const scenario = buildScenario({
      readEnv: () => undefined,
      tokens: { githubPat: "flag-pat", claudeToken: "flag-claude" },
    });
    const completed = await scenario.runSetup();
    expect(completed).toBe(true);
    const paths = resolveSetupPaths(cwd);
    const envContents = scenario.writes.get(paths.envFile) ?? "";
    expect(envContents).toContain("GITHUB_PAT=flag-pat");
    expect(envContents).toContain("CLAUDE_CODE_OAUTH_TOKEN=flag-claude");
  });
});

describe("runSetup — preflight failures", () => {
  it("halts before writing when preflight fails", async () => {
    const scenario = buildScenario({ canAccessRepo: async () => false });
    await expect(scenario.runSetup()).rejects.toBeInstanceOf(ClawError);
    expect(scenario.writes.size).toBe(0);
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
    expect(scenario.removed).toContain(paths.envFile);
    expect(scenario.removed).toContain(paths.configJson);
    expect(scenario.removed).toContain(paths.sessionsDir);
    expect(scenario.removed).toContain(paths.claudeMd);
    expect(scenario.removed).toContain(paths.ciYml);
  });

  it("rolls back every write when runner startup fails", async () => {
    const scenario = buildScenario({
      composeUpBehavior: async () => {
        throw new Error("Docker daemon not running");
      },
    });
    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    const paths = resolveSetupPaths(cwd);
    expect(scenario.removed).toContain(paths.composeFile);
    expect(scenario.removed).toContain(paths.envFile);
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
    expect(scenario.removed).toContain(paths.envFile);
    expect(scenario.removed).toContain(paths.configJson);
    expect(scenario.removed).toContain(paths.sessionsDir);
    expect(scenario.removed).not.toContain(paths.claudeMd);
  });

  it("surfaces BOTH the original failure AND the rollback leftovers when rm partially fails", async () => {
    const paths = resolveSetupPaths(cwd);
    const scenario = buildScenario({
      runGenerator: async () => {
        throw new Error("claude crashed");
      },
      rmBehavior: async (path: string) => {
        if (path === paths.configJson) throw new Error("EPERM");
      },
    });

    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    const clawError = error as ClawError;
    // The original cause survives — the outer message comes from the
    // CLAUDE.md generator, not from the rollback.
    expect(clawError.message).toContain("setup failed");
    expect(clawError.hint).toContain(paths.configJson);
    expect(clawError.hint).toContain("delete manually");
  });
});

describe("runSetup — secret push", () => {
  it("surfaces a ClawError when the secret PUT fails", async () => {
    const scenario = buildScenario({
      createOrUpdateRepoSecretBehavior: async () => {
        throw new Error("422 Unprocessable Entity");
      },
    });
    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain(
      "could not push secret CLAUDE_CODE_OAUTH_TOKEN",
    );
  });
});

describe("runSetup — Docker availability", () => {
  it("halts with a clear error when Docker is missing and skipRunners is false", async () => {
    const scenario = buildScenario({ dockerAvailable: async () => false });
    const error = await scenario.runSetup().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("Docker is required");
  });
});
