import { describe, it, expect } from "vitest";
import {
  buildConfig,
  CURRENT_CLAW_VERSION,
  DEFAULT_POLL_INTERVAL_SECONDS,
  serializeConfig,
} from "../../../src/core/setup/config.js";

describe("buildConfig", () => {
  it("joins owner and repo into owner/repo", () => {
    const config = buildConfig({ owner: "pA1nD", repo: "claw-studio" });
    expect(config.repo).toBe("pA1nD/claw-studio");
  });

  it("stamps the current Claw Studio version by default", () => {
    const config = buildConfig({ owner: "a", repo: "b" });
    expect(config.clawVersion).toBe(CURRENT_CLAW_VERSION);
  });

  it("accepts an explicit version override (forward compatibility)", () => {
    const config = buildConfig({ owner: "a", repo: "b" }, "9.9.9");
    expect(config.clawVersion).toBe("9.9.9");
  });

  it("uses the default poll interval", () => {
    const config = buildConfig({ owner: "a", repo: "b" });
    expect(config.pollInterval).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(config.pollInterval).toBe(60);
  });
});

describe("serializeConfig", () => {
  it("emits JSON indented by two spaces with a trailing newline", () => {
    const config = buildConfig({ owner: "pA1nD", repo: "claw-studio" });
    const serialized = serializeConfig(config);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toContain(`  "repo": "pA1nD/claw-studio"`);
    expect(JSON.parse(serialized)).toEqual(config);
  });
});
