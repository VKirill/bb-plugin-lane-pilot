import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { mountRelay } from "../../src/rooms/relay/server/relay";
import { openDatabase } from "../../src/rooms/storage/database";
import incident from "../fixtures/relay-reload-2026-10-29.json";

const failure = incident.logs.find((row) => row.message.startsWith("relay sweep failed:"))!.message;
const cause = failure.slice("relay sweep failed: ".length);

function setup() {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host.bb);
  const logs: string[] = [];
  let disposed = false;
  host.bb.onDispose(() => { disposed = true; });
  let rejectRead!: (cause: Error) => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  const get = host.bb.storage.kv.get.bind(host.bb.storage.kv);
  let reads = 0;
  const spy = vi.spyOn(host.bb.storage.kv, "get").mockImplementation((key) => {
    // mount's initial watch refresh finishes; only the service's first sweep is held.
    if (key === "relay:items" && ++reads === 2) { entered(); return pending; }
    return get(key);
  });
  mountRelay({ bb: host.bb, db, log: (line: string) => logs.push(line), isDisposed: () => disposed } as never);
  const service = host.harness.behavior.runService("relay-sweep");
  return { host, logs, reading, rejectRead, spy, ...service };
}

describe("relay sweep lifecycle (hub reload 2026-10-29)", () => {
  it("stops before a pending sweep finishes and does not report its late rejection as a failure", async () => {
    const h = setup();
    try {
      await h.reading;
      h.controller.abort();
      await h.done;
      await h.host.harness.dispose();
      h.rejectRead(new Error(cause));
      // Drain the sweep's update chain and its detached catch after the service has stopped.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.logs).not.toContain(failure);
    } finally {
      h.spy.mockRestore();
      await h.host.harness.dispose();
    }
  });

  it.each([cause, "storage read failed"])("still reports a failure while active: %s", async (message) => {
    const h = setup();
    try {
      await h.reading;
      h.rejectRead(new Error(message));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.logs).toContain(`relay sweep failed: ${message}`);
    } finally {
      h.controller.abort();
      await h.done;
      h.spy.mockRestore();
      await h.host.harness.dispose();
    }
  });
});
