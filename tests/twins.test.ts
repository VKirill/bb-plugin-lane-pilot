import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORD_MAX_AGE_MS, shapeOf, twinDiffers, type Shape } from "../src/rooms/twins";
import { TWINS } from "./fixtures/twins";

const dir = join(__dirname, "fixtures/real-shapes");
const records = Object.fromEntries(readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
  const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { name: string; recordedAt: string; shape: Shape };
  return [record.name, record];
}));

describe("twins against the real thing (SMA Q13)", () => {
  it("every shared twin has a recorded real answer, at most a year old", () => {
    for (const name of Object.keys(TWINS)) {
      expect(records[name], `${name}: record it with npx tsx scripts/record-real-shapes.ts`).toBeDefined();
      expect(Date.now() - Date.parse(records[name]!.recordedAt), `${name}: the record is over a year old`).toBeLessThan(RECORD_MAX_AGE_MS);
    }
  });

  it("no twin says what the real answer cannot: no invented key, no other type", () => {
    for (const [name, twin] of Object.entries(TWINS)) expect(twinDiffers(shapeOf(twin), records[name]!.shape), name).toEqual([]);
  });

  it("the check catches an invented key and a changed type, and lets a twin do less", () => {
    const real = shapeOf({ id: "a", status: "idle", nested: { n: 1 }, list: [{ k: "v" }] });
    expect(twinDiffers(shapeOf({ id: "b" }), real)).toEqual([]);
    expect(twinDiffers(shapeOf({ id: "b", colour: "red" }), real)).toEqual(["$.colour: the real thing has no such key"]);
    expect(twinDiffers(shapeOf({ status: 3 }), real)).toEqual(['$.status: the twin gives "number", the real thing "string"']);
    expect(twinDiffers(shapeOf({ list: [{ k: 1 }] }), real)).toEqual(['$.list[].k: the twin gives "number", the real thing "string"']);
    expect(twinDiffers(shapeOf({ nested: "flat" }), real)).toHaveLength(1);
  });

  it("every stub of these answers in every test file names only keys the real answer has", () => {
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? (entry.name === "node_modules" ? [] : files(join(path, entry.name))) : /\.test\.tsx?$/.test(entry.name) ? [join(path, entry.name)] : []);
    const lies: string[] = [];
    let checked = 0;
    for (const file of [...files(join(__dirname)), ...files(join(__dirname, "../src"))]) {
      const text = readFileSync(file, "utf8");
      for (const name of Object.keys(TWINS)) {
        const stub = new RegExp(`stub\\("${name.replace(".", "\\.")}",[^\\n]*?\\(\\{([^{}]*)\\}\\)`, "g");
        for (const hit of text.matchAll(stub)) {
          checked += 1;
          const real = records[name]!.shape;
          const realKeys = new Set(Object.keys(Array.isArray(real) ? real[0] as object : real as object));
          for (const key of [...hit[1]!.matchAll(/(?:^|[,{\s])([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]!)) if (!realKeys.has(key)) lies.push(`${file.slice(file.indexOf("tests/"))}: ${name} stub has «${key}»`);
        }
      }
    }
    expect(lies).toEqual([]);
    // The pattern still finds the stubs (11 on 2026-10-23): a pattern that finds nothing proves nothing.
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});
