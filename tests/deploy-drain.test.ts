import { expect, it } from "vitest";
import { bindDrainTarget, createDeployDrain, DRAIN_SNAPSHOT_KEY, drainForLifecycle } from "../src/server/deploy-drain";
import { experimental_vkLifecycle } from "../src/native-install-lifecycle";

it("holds new checkout writes while draining, reports the running ones, and lets reads through", async () => {
  let clock = 0;
  const drain = createDeployDrain(() => false, () => clock, 5);
  let release!:() => void;
  const merging = drain.around("gitIntegrate", () => new Promise<string>((done) => { release = () => done("merged"); }));
  expect(drain.set(true)).toMatchObject({ draining:true, inFlight:[{ method:"gitIntegrate" }] });
  let started = false;
  const held = drain.around("gitCreateWorktree", async () => { started = true; return "created"; });
  expect(await drain.around("diskFree", async () => "read")).toBe("read");
  await new Promise((wake) => setTimeout(wake, 20));
  expect(started).toBe(false);
  release();
  expect(await merging).toBe("merged");
  expect(drain.status().inFlight).toEqual([]);
  drain.set(false);
  expect(await held).toBe("created");
});

it("ends a drain nobody turned off after 20 minutes", async () => {
  let clock = 0;
  const drain = createDeployDrain(() => false, () => clock, 5);
  drain.set(true);
  clock = 21 * 60_000;
  expect(drain.status().draining).toBe(false);
  expect(await drain.around("gitIntegrate", async () => "ran")).toBe("ran");
});

it("holds acceptance checks while draining like checkout writes", async () => {
  const drain = createDeployDrain(() => false, () => 0, 5);
  drain.set(true);
  let started = false;
  const held = drain.around("runSandboxedCommand", async () => { started = true; return "ran"; });
  await new Promise((wake) => setTimeout(wake, 20));
  expect(started).toBe(false);
  drain.set(false);
  expect(await held).toBe("ran");
});

function lifecycleKv() {
  const rows = new Map<string, unknown>();
  return { rows, kv: { set: async (key: string, value: unknown) => { rows.set(key, value); }, list: async () => [] as string[], get: async () => undefined, delete: async () => undefined } as never };
}
const noCallHost = async () => { throw new Error("a drain does not call hosts"); };

it("a reload drain waits for the running call, saves a snapshot and leaves the drain on", async () => {
  const drain = createDeployDrain(() => false, () => Date.now(), 5);
  const lines: string[] = [];
  bindDrainTarget({ drain, log: (line) => lines.push(line) });
  let release!: () => void;
  const merging = drain.around("gitIntegrate", () => new Promise<void>((done) => { release = done; }));
  const { rows, kv } = lifecycleKv();
  let finished = false;
  const lifecycle = experimental_vkLifecycle({ action: "reload", deadline: Date.now() + 5_000, kv, signal: new AbortController().signal, callHost: noCallHost }).then(() => { finished = true; });
  await new Promise((wake) => setTimeout(wake, 700));
  expect(drain.status().draining).toBe(true);
  expect(finished).toBe(false);
  release(); await merging; await lifecycle;
  expect(rows.get(DRAIN_SNAPSHOT_KEY)).toMatchObject({ action: "reload", clean: true, inFlight: [] });
  expect(lines[0]).toContain("drained for reload");
  expect(drain.status().draining).toBe(true);
  bindDrainTarget(null);
});

it("a drain stops at its deadline with the call still running, and without a bound instance it does nothing", async () => {
  const drain = createDeployDrain(() => false, () => Date.now(), 5);
  bindDrainTarget({ drain, log: () => undefined });
  void drain.around("gitIntegrate", () => new Promise<void>(() => undefined));
  const { rows, kv } = lifecycleKv();
  const result = await drainForLifecycle({ action: "shutdown", deadline: Date.now() + 50, kv, signal: new AbortController().signal }, 10);
  expect(result.clean).toBe(false);
  expect(rows.get(DRAIN_SNAPSHOT_KEY)).toMatchObject({ action: "shutdown", clean: false });
  bindDrainTarget(null);
  await expect(drainForLifecycle({ action: "reload", kv, signal: new AbortController().signal })).resolves.toEqual({ clean: true });
});
