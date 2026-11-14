import { describe, expect, it } from "vitest";
import { NOTE_STACK, observeMemoryPreview, observeSketch } from "./tails-last-world";

// The last tails of the SMA map (cross-region): n1230 (region 16, /sma-sketch) and n1362 (region 16, the memory preview of the project start).
describe("the last tails of the map", () => {
  it("[sma:k_c_sketch] the designer asked for a gray clickable sketch has page-prototype at hand in its own chat and as a specialist; the copy editor's chat does not gain it", () => {
    const seen = observeSketch();
    expect(seen.chat).toEqual(["project-design", "modern-web-guidance", "page-prototype"]);
    expect(seen.specialist).toEqual(["env-catalog", "project-design", "modern-web-guidance", "page-prototype"]);
    expect(seen.copyChat).toEqual(["copywriter"]);
  });

  it("[sma:k_v_mempreview] the memory preview of a project start is read from the hub's confirmed notes of that project and shown in the step's brief; another project's note and an unconfirmed guess stay out, and nothing is written", async () => {
    const seen = await observeMemoryPreview();
    expect(seen.block).toEqual([`- [note] ${NOTE_STACK}`]);
    expect(seen.written).toBe(0);
  });
});
