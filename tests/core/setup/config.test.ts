import { describe, it, expect, vi } from "vitest";
import {
  buildConfig,
  CURRENT_CLAW_VERSION,
  DEFAULT_POLL_INTERVAL_SECONDS,
  readConfig,
  serializeConfig,
} from "../../../src/core/setup/config.js";
import { resolveSetupPaths } from "../../../src/core/setup/paths.js";
import { ClawError } from "../../../src/core/types/errors.js";

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

describe("readConfig", () => {
  const CWD = "/tmp/proj";
  const DETECTED = "pA1nD/claw-studio";
  const CONFIG_PATH = resolveSetupPaths(CWD).configJson;

  it("returns the parsed config when the file is valid", async () => {
    const stored = buildConfig({ owner: "pA1nD", repo: "claw-studio" });
    const result = await readConfig(CWD, DETECTED, {
      readFile: async () => serializeConfig(stored),
    });
    expect(result).toEqual(stored);
  });

  it("reads from `.claw/config.json` under the supplied cwd", async () => {
    const reader = vi.fn(async () => `{"repo":"${DETECTED}"}`);
    await readConfig(CWD, DETECTED, { readFile: reader });
    expect(reader).toHaveBeenCalledWith(CONFIG_PATH);
  });

  it("throws ClawError with the `no .claw/config.json found.` message when the file is missing", async () => {
    let caught: unknown;
    try {
      await readConfig(CWD, DETECTED, { readFile: async () => null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    expect((caught as ClawError).message).toBe("no .claw/config.json found.");
    expect((caught as ClawError).hint).toContain("`claw setup`");
  });

  it("throws ClawError with the JSON-parse hint when the file is not valid JSON", async () => {
    let caught: unknown;
    try {
      await readConfig(CWD, DETECTED, { readFile: async () => "not json {" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    expect((caught as ClawError).message).toBe(
      ".claw/config.json is not valid JSON.",
    );
    expect((caught as ClawError).hint).toContain("--overwrite");
  });

  it("throws ClawError when the JSON parses to a non-object (array, null, primitive)", async () => {
    for (const payload of ["null", "[]", "42", '"a-string"']) {
      let caught: unknown;
      try {
        await readConfig(CWD, DETECTED, { readFile: async () => payload });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ClawError);
      // `null` parses to null and is rejected by the same branch as the
      // primitives above.
      const message = (caught as ClawError).message;
      expect(
        message === ".claw/config.json was not a JSON object." ||
          message === ".claw/config.json is not valid JSON.",
      ).toBe(true);
    }
  });

  it("falls back to the detected repo when the config has no `repo` field", async () => {
    const result = await readConfig(CWD, DETECTED, {
      readFile: async () =>
        JSON.stringify({ pollInterval: 30, clawVersion: "0.1.0" }),
    });
    expect(result.repo).toBe(DETECTED);
    expect(result.pollInterval).toBe(30);
    expect(result.clawVersion).toBe("0.1.0");
  });

  it("falls back to the detected repo when the `repo` field is the empty string", async () => {
    const result = await readConfig(CWD, DETECTED, {
      readFile: async () => JSON.stringify({ repo: "" }),
    });
    expect(result.repo).toBe(DETECTED);
  });

  it("falls back to the default poll interval when the field is missing or non-positive", async () => {
    const missing = await readConfig(CWD, DETECTED, {
      readFile: async () => JSON.stringify({ repo: DETECTED }),
    });
    expect(missing.pollInterval).toBe(DEFAULT_POLL_INTERVAL_SECONDS);

    const zero = await readConfig(CWD, DETECTED, {
      readFile: async () =>
        JSON.stringify({ repo: DETECTED, pollInterval: 0 }),
    });
    expect(zero.pollInterval).toBe(DEFAULT_POLL_INTERVAL_SECONDS);

    const negative = await readConfig(CWD, DETECTED, {
      readFile: async () =>
        JSON.stringify({ repo: DETECTED, pollInterval: -10 }),
    });
    expect(negative.pollInterval).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it("falls back to the current Claw version when the field is missing or empty", async () => {
    const missing = await readConfig(CWD, DETECTED, {
      readFile: async () => JSON.stringify({ repo: DETECTED }),
    });
    expect(missing.clawVersion).toBe(CURRENT_CLAW_VERSION);

    const empty = await readConfig(CWD, DETECTED, {
      readFile: async () =>
        JSON.stringify({ repo: DETECTED, clawVersion: "" }),
    });
    expect(empty.clawVersion).toBe(CURRENT_CLAW_VERSION);
  });
});
