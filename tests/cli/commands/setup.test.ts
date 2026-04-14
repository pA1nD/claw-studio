import { describe, it, expect } from "vitest";
import { buildInkHooks } from "../../../src/cli/commands/setup.js";

describe("buildInkHooks", () => {
  it("returns an object with all three required hook functions", () => {
    const hooks = buildInkHooks();
    expect(typeof hooks.confirm).toBe("function");
    expect(typeof hooks.walkRunnerStep).toBe("function");
    expect(typeof hooks.walkTokenStep).toBe("function");
  });
});
