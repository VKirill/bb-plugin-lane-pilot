import { describe, expect, it } from "vitest";
import { WRITER_ROTATION_SHARE_DEFAULT, rotatedWriterSettings, rotationBucket } from "../src/rooms/writer/writer-fallbacks";

const base = {
  "writer.provider": "acp-cursor", "writer.model": "composer-2.5", "writer.reasoning_effort": "medium",
  "writer.fallback1.provider": "opencode2", "writer.fallback1.model": "router9/ag/gemini-3.8-flash-low", "writer.fallback1.reasoning_effort": "medium",
};
const ids = Array.from({ length: 400 }, (_, index) => `task-${index}`);

describe("writer rotation", () => {
  it("starts about a quarter of the tasks on fallback 1 and makes the writer their first fallback", () => {
    const rotated = ids.map((id) => rotatedWriterSettings(base, id)).filter((settings) => settings["writer.rotated"] === true);
    expect(rotated.length / ids.length).toBeGreaterThan((WRITER_ROTATION_SHARE_DEFAULT - 10) / 100);
    expect(rotated.length / ids.length).toBeLessThan((WRITER_ROTATION_SHARE_DEFAULT + 10) / 100);
    expect(rotated[0]).toMatchObject({ "writer.provider": "opencode2", "writer.model": "router9/ag/gemini-3.8-flash-low", "writer.fallback1.provider": "acp-cursor", "writer.fallback1.model": "composer-2.5" });
  });
  it("is stable per task, off at share 0, everything at 100, and leaves a task alone when fallback 1 is the writer itself", () => {
    const id = ids.find((candidate) => rotationBucket(candidate) < WRITER_ROTATION_SHARE_DEFAULT)!;
    expect(rotatedWriterSettings(base, id)).toEqual(rotatedWriterSettings(base, id));
    expect(ids.some((candidate) => rotatedWriterSettings({ ...base, "writer.rotation_share": 0 }, candidate)["writer.rotated"])).toBe(false);
    expect(ids.every((candidate) => rotatedWriterSettings({ ...base, "writer.rotation_share": 100 }, candidate)["writer.rotated"])).toBe(true);
    const same = { ...base, "writer.fallback1.provider": "acp-cursor", "writer.fallback1.model": "composer-2.5" };
    expect(rotatedWriterSettings(same, id)).toBe(same);
  });
});
