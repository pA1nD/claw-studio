import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  resolveRequiredPaths,
  resolveSetupPaths,
} from "../../../src/core/setup/paths.js";

describe("resolveSetupPaths", () => {
  const cwd = "/tmp/claw-target";
  const paths = resolveSetupPaths(cwd);

  it("places .claw/ at the working directory root", () => {
    expect(paths.clawDir).toBe(join(cwd, ".claw"));
  });

  it("resolves every file in the canonical footprint", () => {
    expect(paths.claudeMd).toBe(join(cwd, ".claw", "CLAUDE.md"));
    expect(paths.configJson).toBe(join(cwd, ".claw", "config.json"));
    expect(paths.sessionsDir).toBe(join(cwd, ".claw", "sessions"));
    expect(paths.workflowsDir).toBe(join(cwd, ".github", "workflows"));
    expect(paths.ciYml).toBe(join(cwd, ".github", "workflows", "ci.yml"));
  });

  it("exposes .claw/.env for token persistence", () => {
    expect(paths.envFile).toBe(join(cwd, ".claw", ".env"));
  });

  it("exposes .claw/runners/docker-compose.yml for the Docker runner pool", () => {
    expect(paths.runnersDir).toBe(join(cwd, ".claw", "runners"));
    expect(paths.composeFile).toBe(
      join(cwd, ".claw", "runners", "docker-compose.yml"),
    );
  });

  it("exposes the .gitignore at the project root (never inside .claw)", () => {
    expect(paths.gitignore).toBe(join(cwd, ".gitignore"));
  });
});

describe("resolveRequiredPaths", () => {
  it("points README and ROADMAP at the working directory root", () => {
    const required = resolveRequiredPaths("/tmp/claw-target");
    expect(required.readme).toBe("/tmp/claw-target/README.md");
    expect(required.roadmap).toBe("/tmp/claw-target/ROADMAP.md");
  });
});
