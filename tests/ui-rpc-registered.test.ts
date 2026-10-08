import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { rpcContract } from "../src/rooms/contracts";
import { roomFaceFiles } from "./support/room-files";

/**
 * 0.1.188 shipped a button that called `workflow_architect_start`, which no server registered: «plugin "lane-pilot" has no rpc
 * method». Every RPC a screen calls by name must be in the contract and registered on the server.
 */
const ROOT = join(__dirname, "..");

/** `rpc.call("name"`, `host.call<T>("name"` and the helper form `call(rpc, "name"`. */
export function calledRpcNames(source: string): string[] {
  const direct = [...source.matchAll(/\.call(?:<[^>()]*>)?\(\s*["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]!);
  const helper = [...source.matchAll(/\bcall\(\s*\w+\s*,\s*["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]!);
  return [...direct, ...helper];
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("every RPC the screens call is registered", () => {
  it("finds the calls the scan is meant to see", () => {
    expect(calledRpcNames('await rpc.call(\n  "workflow_list", {})')).toEqual(["workflow_list"]);
    expect(calledRpcNames('call(rpc, "workflow_architect_start", { projectId })')).toEqual(["workflow_architect_start"]);
    expect(calledRpcNames("Object.prototype.hasOwnProperty.call(drafts, key)")).toEqual([]);
  });

  it("the UI of every room and app.tsx call only methods of the contract, and the server registers the whole contract", async () => {
    const sources = [...roomFaceFiles("ui"), join(ROOT, "app.tsx")];
    const called = new Map<string, string[]>();
    for (const file of sources) for (const name of calledRpcNames(readFileSync(file, "utf8"))) called.set(name, [...(called.get(name) ?? []), file.slice(ROOT.length + 1)]);
    expect(called.size).toBeGreaterThan(30);

    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const registered = new Set(harness.registrations.rpcMethods);
    const missing = [...called].filter(([name]) => !registered.has(name)).map(([name, where]) => `${name} (${[...new Set(where)].join(", ")})`);
    expect(missing).toEqual([]);
    expect(Object.keys(rpcContract).filter((name) => !registered.has(name))).toEqual([]);
    expect(registered.has("workflow_architect_start")).toBe(true);
  });
});
