import { describe, expect, it } from "vitest";
import { ownerAskPayloadSchema } from "../src/rooms/relay/owner-ask";
import { readOwnerAskPayload } from "../src/rooms/relay/owner-ask-shared";

// The screen reads a question with a zod-free parser (zod stays out of the browser bundle); it must agree with the schema.
describe("readOwnerAskPayload agrees with ownerAskPayloadSchema", () => {
  const good = { v: 1, source: "gate", question: "Gate is red", options: [{ id: "1", label: "Fix" }], allowText: true };
  const cases: Array<[string, unknown]> = [
    ["a full question", { ...good, detail: "log" }],
    ["no options", { ...good, options: [] }],
    ["an empty detail", { ...good, detail: "" }],
    ["not an object", "text"],
    ["null", null],
    ["wrong version", { ...good, v: 2 }],
    ["unknown source", { ...good, source: "other" }],
    ["empty question", { ...good, question: "" }],
    ["too long question", { ...good, question: "q".repeat(2001) }],
    ["too long detail", { ...good, detail: "d".repeat(4001) }],
    ["detail not a string", { ...good, detail: 3 }],
    ["seven options", { ...good, options: Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), label: "x" })) }],
    ["empty option label", { ...good, options: [{ id: "1", label: "" }] }],
    ["too long option id", { ...good, options: [{ id: "i".repeat(41), label: "x" }] }],
    ["unknown key on the option (dropped)", { ...good, options: [{ id: "1", label: "x", more: 1 }] }],
    ["unknown key on the question (dropped)", { ...good, more: 1 }],
    ["allowText missing", { v: 1, source: "gate", question: "q", options: [] }],
    ["options not an array", { ...good, options: "none" }],
  ];
  for (const [name, value] of cases) {
    it(name, () => {
      expect(readOwnerAskPayload(value) !== null).toBe(ownerAskPayloadSchema.safeParse(value).success);
    });
  }
  it("returns the parsed question", () => {
    expect(readOwnerAskPayload({ ...good, detail: "log" })).toEqual({ ...good, detail: "log" });
  });
});
