import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { patchOpenCodePlugin } from "../src/jsonc";

const sha = (text:string) => createHash("sha256").update(text).digest("hex");
const valid = [
  ["key_present_json", '{"plugin":["./plugins/lane-context.ts","./plugins/custom.ts"]}\n'],
  ["key_present_jsonc", '{\n  // keep\n  "plugin": ["./plugins/lane-context.ts", "./plugins/custom.ts"],\n}\n'],
  ["key_absent", '{"theme":"dark"}\n'],
  ["empty_object", '{}\n'],
  ["comment_inside_array", '{"plugin":[\n  "./plugins/custom.ts", // keep custom\n  "./plugins/lane-context.ts",\n]}\n'],
  ["trailing_commas", '{"plugin":["./plugins/lane-context.ts",],}\n'],
] as const;
const invalid = [
  ["duplicate", '{"plugin":[],"plugin":[]}\n', "duplicate_plugin"],
  ["object", '{"plugin":{}}\n', "invalid_plugin"],
  ["number", '{"plugin":[1]}\n', "invalid_plugin"],
  ["null", '{"plugin":null}\n', "invalid_plugin"],
  ["nested", '{"nested":{"plugin":[]}}\n', "nested_plugin"],
] as const;

describe("E4 JSONC patch", () => {
  for (const [name, input] of valid) {
    it(`${name} is trivia-safe and idempotent`, () => {
      const first = patchOpenCodePlugin(input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.text).toContain("./plugins/opencode-lane.ts");
      expect(first.text).not.toContain("./plugins/lane-context.ts");
      if (input.includes("keep")) expect(first.text).toContain("keep");
      const second = patchOpenCodePlugin(first.text);
      expect(second).toEqual({ok:true, changed:false, text:first.text});
      if (second.ok) expect(sha(second.text)).toBe(sha(first.text));
    });
  }
  for (const [name, input, code] of invalid) {
    it(`${name} fails closed on both passes`, () => {
      const first = patchOpenCodePlugin(input);
      const second = patchOpenCodePlugin(input);
      expect(first).toMatchObject({ok:false, code});
      expect(second).toEqual(first);
      expect(sha(input)).toBe(sha(input));
    });
  }
});
