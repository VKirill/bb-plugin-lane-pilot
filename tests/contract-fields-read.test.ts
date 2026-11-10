/**
 * Regenerate the baseline after a clean-up: UPDATE_BASELINES=1 npx vitest run tests/contract-fields-read.test.ts tests/guard-tools.test.ts
 * (it rewrites tests/fixtures/unread-fields-baseline.json and tests/fixtures/house-words-baseline.json; review the diff before you commit it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rpcContract } from "../src/rooms/contracts";
import { unreadFields, UNSHOWN_FIELDS } from "./helpers/guard-tools";
import { roomFaceFiles } from "./support/room-files";

/**
 * Window contract is read (SMA map: Window contract is read, Contract check in tests): every field the server answers to the
 * window is either read by rendering code or named in the register with why. The baseline carries today's unread fields, so a
 * NEW unread field turns the suite red; shrink the baseline into UNSHOWN_FIELDS with reasons over time. A baseline entry that is read now
 * only prints a note: «read» is a loose word match, so another branch's text can make a field look read or unread by accident.
 */
const ROOT = join(__dirname, "..");
const baselineFile = join(ROOT, "tests/fixtures/unread-fields-baseline.json");
const baseline = new Set(JSON.parse(readFileSync(baselineFile, "utf8")) as string[]);

const uiSources = [...roomFaceFiles("ui"), join(ROOT, "app.tsx")].map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("every answer field is read by a screen or explained in the register", () => {
  it("no field outside the baseline and the register is left unread", () => {
    const unread = unreadFields(rpcContract as never, uiSources, UNSHOWN_FIELDS);
    const fresh = unread.filter((field) => !baseline.has(field));
    expect(fresh).toEqual([]);
  });

  it("the baseline still matches reality: a now-read field is only noted, never a failure", () => {
    const unread = new Set(unreadFields(rpcContract as never, uiSources, UNSHOWN_FIELDS));
    const stale = [...baseline].filter((field) => !unread.has(field));
    if (stale.length) console.warn(`unread-fields baseline: ${stale.length} entries are read or explained now and can leave it (UPDATE_BASELINES=1 rewrites the file): ${stale.join(", ")}`);
    if (process.env.UPDATE_BASELINES === "1") writeFileSync(baselineFile, `${JSON.stringify([...unread].sort(), null, 2)}\n`);
    expect(Array.isArray(stale)).toBe(true);
  });
});
