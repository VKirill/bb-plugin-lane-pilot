import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atlasHash, renderAtlas } from "../src/rooms/atlas";
import { collectAtlasInput } from "../scripts/atlas-input";

const root = join(__dirname, "..");

describe("the atlas of Lane Pilot (SMA D2-11)", () => {
  it("docs/atlas.md was generated from the registries the code has now", () => {
    const input = collectAtlasInput(root);
    expect(readFileSync(join(root, "docs/atlas.md"), "utf8"), "run: npx tsx scripts/generate-atlas.ts").toContain(`<!-- atlas:structure ${atlasHash(input)} -->`);
  });

  it("lists every room once with its public API, and the hash ignores sizes", () => {
    const input = collectAtlasInput(root);
    expect(new Set(input.rooms.map((room) => room.name)).size).toBe(input.rooms.length);
    expect(input.rooms.find((room) => room.name === "wires")!.publicExports).toContain("wiresCommand");
    expect(atlasHash({ ...input, rooms: input.rooms.map((room) => ({ ...room, lines: room.lines + 1 })), largestFiles: [] })).toBe(atlasHash(input));
    expect(atlasHash({ ...input, rpc: [...input.rpc, "new_method"] })).not.toBe(atlasHash(input));
    expect(renderAtlas(input)).toContain("stateDiagram-v2");
  });
});
