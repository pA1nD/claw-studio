import { describe, it, expect, vi } from "vitest";
import { ClawError } from "../../../src/core/types/errors.js";
import {
  rollbackOrThrow,
  WriteTracker,
} from "../../../src/core/setup/write.js";

describe("WriteTracker", () => {
  it("records every writeFile and mkdir call with the right kind", async () => {
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
    });

    await tracker.writeFile("/tmp/a/file.txt", "contents");
    await tracker.mkdir("/tmp/a/sub");

    expect(tracker.artifacts).toEqual([
      { path: "/tmp/a/file.txt", kind: "file" },
      { path: "/tmp/a/sub", kind: "dir" },
    ]);
  });

  it("ensures the parent directory exists before writing a file", async () => {
    const mkdir = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const tracker = new WriteTracker({
      mkdir,
      writeFile,
      rm: async () => undefined,
    });

    await tracker.writeFile("/tmp/nested/dir/file.txt", "hi");
    expect(mkdir).toHaveBeenCalledWith("/tmp/nested/dir");
    expect(writeFile).toHaveBeenCalledWith("/tmp/nested/dir/file.txt", "hi");
  });

  it("rollback removes everything in reverse order", async () => {
    const order: string[] = [];
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      rm: async (path: string) => {
        order.push(path);
      },
    });

    await tracker.writeFile("/tmp/first.txt", "a");
    await tracker.mkdir("/tmp/second");
    await tracker.writeFile("/tmp/second/third.txt", "c");

    const failures = await tracker.rollback();
    expect(failures).toEqual([]);
    expect(order).toEqual([
      "/tmp/second/third.txt",
      "/tmp/second",
      "/tmp/first.txt",
    ]);
  });

  it("rollback collects (does not throw on) individual removal failures", async () => {
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      rm: async (path: string) => {
        if (path === "/tmp/b") throw new Error("permission denied");
      },
    });

    await tracker.writeFile("/tmp/a", "a");
    await tracker.writeFile("/tmp/b", "b");

    const failures = await tracker.rollback();
    expect(failures).toEqual(["/tmp/b"]);
  });

  it("rollback is idempotent — a second call has nothing left to do", async () => {
    const rm = vi.fn(async () => undefined);
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      rm,
    });

    await tracker.writeFile("/tmp/x", "x");
    await tracker.rollback();
    await tracker.rollback();
    expect(rm).toHaveBeenCalledTimes(1);
  });
});

describe("rollbackOrThrow", () => {
  it("resolves cleanly when rollback removes everything", async () => {
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      rm: async () => undefined,
    });
    await tracker.writeFile("/tmp/x", "x");
    await expect(rollbackOrThrow(tracker)).resolves.toBeUndefined();
  });

  it("throws a ClawError listing the paths that could not be removed", async () => {
    const tracker = new WriteTracker({
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      rm: async (path: string) => {
        if (path.endsWith("dirty")) throw new Error("nope");
      },
    });
    await tracker.writeFile("/tmp/clean", "c");
    await tracker.writeFile("/tmp/dirty", "d");

    const error = await rollbackOrThrow(tracker).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).hint).toContain("/tmp/dirty");
  });
});
