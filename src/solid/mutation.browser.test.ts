import { describe, expect, it } from "bun:test";

// Runs against the browser build of Solid, where effects really observe the signals.
// The server build (default `bun test`) does not run effects the same way.
const defineBrowserMutationTests = async () => {
  const { createEffect, createRenderEffect } = await import("solid-js");
  const { testRoot } = await import("../_test-helpers");
  const { mutation } = await import("./mutation");

  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  describe("mutation observed through effects (browser build)", () => {
    it("shows pending, loading, and the end once, with settledAt changing on every end", async () => {
      let time = 5;
      const seen: string[] = [];
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({
          now: () => time,
          onBefore: async () => {},
          mutation: async () => {
            throw new Error("same");
          },
        });
        createEffect(() => seen.push(`${m.status()}@${m.settledAt()}`));
        return m;
      });
      await flush();
      expect(await m.mutate(undefined)).toBe("error");
      await flush();
      expect(await m.mutate(undefined)).toBe("error");
      await flush();
      time = 100;
      expect(await m.mutate(undefined)).toBe("error");
      await flush();
      expect(seen).toEqual([
        "idle@null",
        "pending@null",
        "loading@null",
        "error@5",
        "pending@5",
        "loading@5",
        "error@6",
        "pending@6",
        "loading@6",
        "error@100",
      ]);
      dispose();
    });

    it("a reader error at start does not lock the mutation and leaves the previous end", async () => {
      let runs = 0;
      let armed = false;
      const seen: string[] = [];
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({
          now: () => 10,
          onBefore: async () => {},
          mutation: async () => ++runs,
        });
        createRenderEffect(() => {
          const status = m.status();
          seen.push(`${status}@${m.settledAt()}`);
          if (status === "pending" && armed) {
            armed = false;
            throw new Error("consumer");
          }
        });
        return m;
      });
      expect(await m.mutate(undefined)).toBe("success");
      armed = true;
      await expect(m.mutate(undefined)).rejects.toThrow("consumer");
      expect(m.status()).toBe("success");
      expect(m.settledAt()).toBe(10);
      expect(runs).toBe(1);
      expect(await m.mutate(undefined)).toBe("success");
      expect(runs).toBe(2);
      expect(m.settledAt()).toBe(11);
      dispose();
    });

    it("a reader error when loading starts does not lock the mutation", async () => {
      let armed = true;
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({ mutation: async (value: string) => value });
        createRenderEffect(() => {
          if (m.loading() && armed) {
            armed = false;
            throw new Error("consumer");
          }
        });
        return m;
      });
      await expect(m.mutate("a")).rejects.toThrow("consumer");
      expect(m.status()).toBe("idle");
      expect(await m.mutate("b")).toBe("success");
      expect(m.data()).toBe("b");
      dispose();
    });

    it("abort during pending shows aborted once and ignores the later onBefore result", async () => {
      const before = deferred<void>();
      const seen: string[] = [];
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({
          now: () => 20,
          onBefore: () => before.promise,
          mutation: async () => 1,
        });
        createEffect(() => seen.push(`${m.status()}@${m.settledAt()}`));
        return m;
      });
      await flush();
      const call = m.mutate(undefined);
      await flush();
      m.abort();
      expect(await call).toBe("aborted");
      before.resolve();
      await flush();
      expect(seen).toEqual(["idle@null", "pending@null", "aborted@20"]);
      dispose();
    });

    it("replace: a failing newer onBefore never shows an end while the older run loads", async () => {
      const work = deferred<string>();
      let time = 1_000;
      let calls = 0;
      const seen: string[] = [];
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({
          concurrency: "replace",
          now: () => time,
          onBefore: () => {
            if (++calls === 2) throw new Error("before B");
          },
          mutation: (_value: string) => work.promise,
        });
        createEffect(() => seen.push(`${m.status()}@${m.settledAt()}`));
        return m;
      });
      await flush();
      const a = m.mutate("A");
      await flush();
      expect(await m.mutate("B")).toBe("error");
      await flush();
      time = 2_000;
      work.resolve("A");
      expect(await a).toBe("success");
      await flush();
      expect(seen.filter((entry) => entry.startsWith("loading"))).toEqual(["loading@null"]);
      expect(seen.at(-1)).toBe("success@2000");
      expect(m.error()).toBeNull();
      dispose();
    });
  });
};

if (process.env.STDLIB_SOLID_BROWSER_TESTS === "1") {
  await defineBrowserMutationTests();
} else {
  describe("mutation browser suite", () => {
    it("passes with SolidJS browser conditions", async () => {
      const child = Bun.spawn([process.execPath, "test", "--conditions=browser", import.meta.path], {
        cwd: process.cwd(),
        env: { ...process.env, STDLIB_SOLID_BROWSER_TESTS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Mutation browser tests failed:\n${stdout}\n${stderr}`);
      }
    });
  });
}
