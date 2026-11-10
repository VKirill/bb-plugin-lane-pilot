import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rpcContract } from "../src/rooms/contracts";
import { unreadFields, UNSHOWN_FIELDS } from "./helpers/guard-tools";
import { roomFaceFiles } from "./support/room-files";

/**
 * Window contract is read (SMA map: Window contract is read, Contract check in tests): every field the server answers to the
 * window is either read by rendering code or named in the register with why. The baseline carries today's unread fields, so a
 * NEW unread field turns the suite red; shrink the baseline into UNSHOWN_FIELDS with reasons over time.
 */
const ROOT = join(__dirname, "..");
const baseline = new Set(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/unread-fields-baseline.json"), "utf8")) as string[]);

const uiSources = [...roomFaceFiles("ui"), join(ROOT, "app.tsx")].map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("every answer field is read by a screen or explained in the register", () => {
  it("no field outside the baseline and the register is left unread", () => {
    const unread = unreadFields(rpcContract as never, uiSources, UNSHOWN_FIELDS);
    const fresh = unread.filter((field) => !baseline.has(field));
    expect(fresh).toEqual([]);
  });

  it("the baseline still matches reality: a explained-away or now-read field leaves the baseline", () => {
    const unread = new Set(unreadFields(rpcContract as never, uiSources, UNSHOWN_FIELDS));
    const stale = [...baseline].filter((field) => !unread.has(field));
    expect(stale).toEqual([]);
  });
});
