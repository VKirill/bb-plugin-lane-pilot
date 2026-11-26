import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/refactor/graph";
import { createCore } from "../../src/rooms/core/server/core";
import { cliCommands, registerCli } from "../../src/rooms/tools/server";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import { roomCliVerbs, roomRpcHandlers, rooms } from "../../src/rooms/registry";
import { registerRpc } from "../../src/rooms/core/server/rpc";
import { rpcContract } from "../../src/rooms/core/server/plugin-contracts";
import type { Services } from "../../src/rooms/services";

/** A services bag whose every field is something callable and indexable: handlers are only built here, never called. */
const services = (): Services => new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => undefined }) }) as unknown as Services;

/**
 * Rooms with a server/ folder that are not in src/rooms/registry.ts yet. It may only shrink: convert a room (export `room`, add it to
 * the array) and delete its name here. A room that is deleted leaves this list with its folder.
 */
// tools composes every room's CLI verbs from the registry, so registering it would make the registry and tools import each other.
const NOT_REGISTERED = new Set<string>(["contracts", "core", "tools"]);

const roomsWithServer = () => readdirSync(join(ROOT, "src/rooms"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "src/rooms", entry.name, "server")))
  .map((entry) => entry.name);

describe("room registry", () => {
  it("lists every room with a server folder, or names it as not converted yet", () => {
    const registered = new Set(rooms.map((room) => room.name));
    const missing = roomsWithServer().filter((name) => !registered.has(name) && !NOT_REGISTERED.has(name));
    expect(missing, "export `room` from the room's public index and add it to src/rooms/registry.ts").toEqual([]);
    expect([...NOT_REGISTERED].filter((name) => registered.has(name)), "registered now: delete it from NOT_REGISTERED").toEqual([]);
    expect([...NOT_REGISTERED].filter((name) => !roomsWithServer().includes(name)), "no such room folder: delete it from NOT_REGISTERED").toEqual([]);
  });

  it("names every room once, after its folder", () => {
    const names = rooms.map((room) => room.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => !existsSync(join(ROOT, "src/rooms", name)))).toEqual([]);
  });

  it("declares every verb once, and the help lists it", () => {
    const names = roomCliVerbs.map((verb) => verb.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
    const all = cliCommands.map((command) => command.name);
    expect(all.filter((name, at) => all.indexOf(name) !== at), "a verb is in cli-commands.ts and in a room").toEqual([]);
  });

  it("resolves each verb with `explain`", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
    for (const verb of roomCliVerbs) {
      const result = await harness.behavior.runCli(["explain", verb.name]);
      expect(result.exitCode, verb.name).toBe(0);
      expect(result.stdout ?? "", verb.name).toContain(verb.name);
    }
  });

  it("gives every key of the RPC contract a handler, each from one place", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const ctx = createCore(bb, openDatabase(bb));
    expect(() => registerRpc(ctx, services(), rpcContract)).not.toThrow();
    const offered = Object.keys(roomRpcHandlers(ctx, services()));
    expect(offered.filter((key, at) => offered.indexOf(key) !== at)).toEqual([]);
    expect(offered.length).toBeGreaterThan(0);
  });

  it("keeps each room's migrations in the locked list as one run", () => {
    const hashes = migrations.map((statement) => createHash("sha256").update(statement).digest("hex"));
    for (const room of rooms) {
      if (!room.migrations?.length) continue;
      const first = migrations.indexOf(room.migrations[0]!);
      expect(first, `${room.name}: its first statement is not in src/rooms/migrations.ts`).toBeGreaterThanOrEqual(0);
      const slice = migrations.slice(first, first + room.migrations.length);
      expect(slice.map((statement) => createHash("sha256").update(statement).digest("hex")), room.name).toEqual(room.migrations.map((statement) => createHash("sha256").update(statement).digest("hex")));
      expect(hashes.length).toBeGreaterThan(first);
    }
  });
});
