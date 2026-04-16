import { describe, it, expect } from "vitest";
import { buildInkHooks } from "../../../src/cli/commands/setup.js";

describe("buildInkHooks", () => {
  it("returns an object with the confirm hook (the only interactive step)", () => {
    const hooks = buildInkHooks();
    expect(typeof hooks.confirm).toBe("function");
  });

  it("no longer ships interactive runner/token walkthroughs", () => {
    // Per issue #30 the walk hooks are gone — setup runs headless.
    const hooks = buildInkHooks() as Record<string, unknown>;
    expect(hooks["walkRunnerStep"]).toBeUndefined();
    expect(hooks["walkTokenStep"]).toBeUndefined();
  });
});
