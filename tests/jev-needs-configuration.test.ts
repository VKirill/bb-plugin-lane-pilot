import { describe, expect, it } from "vitest";
import { flagMissingJevKey } from "../src/rooms/core/server/core";

describe("flagMissingJevKey (B-4)", () => {
  it("marks needsConfiguration when no Jev key is named in the catalog", async () => {
    const marks: string[] = [];
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, async () => false);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatch(/Jev key/);
  });

  it("stays quiet with a key, when the catalog cannot be asked, without the status area, and on a lookup failure", async () => {
    const marks: string[] = [];
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, async () => true);
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, async () => null);
    await flagMissingJevKey({}, async () => false);
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, async () => { throw new Error("catalog down"); });
    expect(marks).toEqual([]);
  });
});
