import { describe, expect, it } from "vitest";
import { enumCoverage, literalCoverage, schemaEnums } from "@lane-pilot/kit/prompt-coverage";

describe("literalCoverage", () => {
  it("matches whole words only", () => {
    const covered = literalCoverage(["fail", "pass"], "A step may end as failed, prefail or fail_safe; (pass) is fine.");
    expect(covered.mentioned).toEqual(["pass"]);
    expect(covered.missing).toEqual(["fail"]);
    expect(literalCoverage(["fail"], "a fail, then more").missing).toEqual([]);
    expect(literalCoverage(["fail"], "fail-closed").missing).toEqual([]);
    expect(literalCoverage(["fail"], "\"fail\"|\"pass\"").missing).toEqual([]);
  });

  it("is case sensitive unless told otherwise", () => {
    expect(literalCoverage(["pass"], "PASS").missing).toEqual(["pass"]);
    expect(literalCoverage(["pass"], "PASS", { ignoreCase: true }).missing).toEqual([]);
  });

  it("reports a partial enum: some named, some not", () => {
    expect(literalCoverage(["a", "b", "c"], "a and b")).toEqual({ mentioned: ["a", "b"], missing: ["c"], partial: true });
    expect(literalCoverage(["a", "b"], "nothing")).toEqual({ mentioned: [], missing: ["a", "b"], partial: false });
    expect(literalCoverage(["a", "b"], "a b")).toEqual({ mentioned: ["a", "b"], missing: [], partial: false });
  });

  it("reads each text on its own, so the edges of two texts do not join into a word", () => {
    expect(literalCoverage(["fail"], ["fai", "l"]).missing).toEqual(["fail"]);
    expect(literalCoverage(["fail"], ["nothing", "fail"]).missing).toEqual([]);
  });

  it("matches phrases and markers literally, with composed and decomposed accents alike", () => {
    expect(literalCoverage(["NEEDS_HUMAN: "], "write NEEDS_HUMAN: <question>").missing).toEqual([]);
    expect(literalCoverage(["a.c"], "abc").missing).toEqual(["a.c"]);
    expect(literalCoverage(["caf\u00e9"], "cafe\u0301").missing).toEqual([]);
    expect(literalCoverage(["fail"], "a\r\nfail\r\n").missing).toEqual([]);
  });
});

describe("schemaEnums", () => {
  const schema = {
    type: "object",
    properties: {
      status: { enum: ["pass", "fail"] },
      rows: { type: "array", items: { properties: { kind: { anyOf: [{ const: "x" }, { enum: ["y", "z"] }] } } } },
      again: { $ref: "#/$defs/level" },
      twice: { $ref: "#/$defs/level" },
    },
    $defs: { level: { enum: ["low", "high"] } },
  };

  it("collects enum and const values with their pointers, through items, alternatives and local refs, each definition once", () => {
    expect(schemaEnums(schema)).toEqual([
      { path: "#/properties/status/enum", values: ["pass", "fail"] },
      { path: "#/properties/rows/items/properties/kind/anyOf/0/const", values: ["x"] },
      { path: "#/properties/rows/items/properties/kind/anyOf/1/enum", values: ["y", "z"] },
      { path: "#/$defs/level/enum", values: ["low", "high"] },
    ]);
  });

  it("checks every group against the texts", () => {
    const report = enumCoverage(schema, "pass, x, y and low");
    expect(report.map((group) => [group.path, group.missing, group.partial])).toEqual([
      ["#/properties/status/enum", ["fail"], true],
      ["#/properties/rows/items/properties/kind/anyOf/0/const", [], false],
      ["#/properties/rows/items/properties/kind/anyOf/1/enum", ["z"], true],
      ["#/$defs/level/enum", ["high"], true],
    ]);
  });
});
