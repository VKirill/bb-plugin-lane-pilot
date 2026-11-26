import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { mountRelay } from "../../src/rooms/relay/server/handlers/relay-tools";
import { openDatabase } from "../../src/rooms/plugin-db";
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
    // mount's initial watch refresh finishes; the initial event/deadline sweep is held.
    if (key === "relay:items" && ++reads === 2) { entered(); return pending; }
    return get(key);
  });
  mountRelay({ bb: host.bb, db, log: (line: string) => logs.push(line), isDisposed: () => disposed } as never);
  return { host, logs, reading, rejectRead, spy };
}

describe("relay deadline/event lifecycle (hub reload 2026-10-29)", () => {
  it("disposes cleanly without a background sweep service and does not report late rejection after dispose", async () => {
    const h = setup();
    try {
      await h.reading;
      await h.host.harness.dispose();
      h.rejectRead(new Error(cause));
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
      h.spy.mockRestore();
      await h.host.harness.dispose();
    }
  });
});
