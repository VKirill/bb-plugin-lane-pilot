import { describe, expect, it } from "vitest";
import { flagMissingJevKey } from "../src/rooms/core/server/core";

describe("flagMissingJevKey (B-4)", () => {
  const endpoint = (apiKey: string | undefined) => async () => ({ apiKey });

  it("marks needsConfiguration when no Jev key resolves", async () => {
    const marks: string[] = [];
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, endpoint(undefined));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatch(/Jev key/);
  });

  it("stays quiet with a key, without the status area, and on a key-lookup failure", async () => {
    const marks: string[] = [];
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, endpoint("sk-live"));
    await flagMissingJevKey({}, endpoint(undefined));
    await flagMissingJevKey({ status: { needsConfiguration: (m) => marks.push(m) } }, async () => { throw new Error("catalog down"); });
    expect(marks).toEqual([]);
  });
});
