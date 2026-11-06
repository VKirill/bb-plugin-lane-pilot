import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atlasHash, renderAtlas } from "../src/rooms/atlas";
import { collectAtlasInput } from "../scripts/atlas-input";
import { collectSystemMap } from "../scripts/system-map";

const root = join(__dirname, "..");

describe("the atlas of Lane Pilot (SMA D2-11)", () => {
  it("docs/atlas.md was generated from the registries the code has now", () => {
    const input = collectAtlasInput(root);
    expect(readFileSync(join(root, "docs/atlas.md"), "utf8"), "run: npx tsx scripts/generate-atlas.ts").toContain(`<!-- atlas:structure ${atlasHash(input)} -->`);
    expect(readFileSync(join(root, "README.md"), "utf8"), "run: npx tsx scripts/generate-atlas.ts").toContain(`<!-- numbers:start ${atlasHash(input)} -->`);
    expect(readFileSync(join(root, "docs/map/index.html"), "utf8"), "run: npx tsx scripts/generate-atlas.ts").toContain(`structure ${atlasHash(input)}`);
  });

  it("the system map puts each table with the code that owns it and links graphs to what they run", () => {
    const map = collectSystemMap(root);
    const node = (id: string) => map.nodes.find((item) => item.id === id);
    expect(node("table:lane_pilot_wall_repair")?.parent).toBe("room:wall");
    expect(map.nodes.some((item) => item.type === "table" && item.parent === "room:sma-map")).toBe(false);
    expect(node("cmd:errands")?.parent).toBe("room:errands");
    expect(map.edges.some((edge) => edge.source === "graph:invoice-send" && edge.type === "runs")).toBe(true);
    expect(map.nodes.filter((item) => item.type !== "area" && item.type !== "group").every((item) => item.x !== undefined || map.nodes.some((child) => child.parent === item.id))).toBe(true);
  });

  it("lists every room once with its public API, and the hash ignores sizes", () => {
    const input = collectAtlasInput(root);
    expect(new Set(input.rooms.map((room) => room.name)).size).toBe(input.rooms.length);
    expect(input.rooms.find((room) => room.name === "wires")!.publicExports).toContain("wiresCommand");
    expect(atlasHash({ ...input, rooms: input.rooms.map((room) => ({ ...room, lines: room.lines + 1 })), largestFiles: [] })).toBe(atlasHash(input));
    expect(atlasHash({ ...input, rpc: [...input.rpc, "new_method"] })).not.toBe(atlasHash(input));
    expect(atlasHash({ ...input, cli: [...input.cli, { name: "new-command", summary: "" }] })).not.toBe(atlasHash(input));
    expect(input.cli.map((command) => command.name)).toContain("errands");
    expect(input.graphs.length).toBeGreaterThan(50);
    expect(renderAtlas(input)).toContain("stateDiagram-v2");
  });
});
