import { describe, expect, it } from "vitest";
import fixture from "./fixtures/hub-writer-questions-30d.json";
import { classifyQuestion, filesNamed } from "../src/rooms/writer/server/question-class";
import { writerQuestion } from "../src/rooms/writer/server/reopen-attempt";

type Row = { reason: string; label: string };
const rows = fixture as Row[];

describe("question classifier on the hub's writer questions (30 days, hand-labelled)", () => {
  it("bounds the confusion", () => {
    const confusion: Record<string, Record<string, number>> = {};
    let right = 0;
    const wrong: string[] = [];
    rows.forEach((row, index) => {
      const got = classifyQuestion(writerQuestion(row.reason)).kind;
      confusion[row.label] ??= {};
      confusion[row.label]![got] = (confusion[row.label]![got] ?? 0) + 1;
      if (got === row.label) right++; else wrong.push(`${index}: ${row.label} -> ${got}`);
    });
    if (process.env.PRINT_CONFUSION) console.log(JSON.stringify(confusion), `\n${wrong.join("\n")}`);
    expect(rows).toHaveLength(67);
    expect(right / rows.length).toBeGreaterThanOrEqual(0.85);
    expect(confusion.other?.outside_paths ?? 0).toBe(0);
  });

  it("names the files of an outside-paths question", () => {
    const q = "npx tsc --noEmit fails in src/components/cipher-tools/dice.tsx, src/screens/newsreel.tsx, outside owns_paths and not caused by this task";
    expect(classifyQuestion(q)).toEqual({ kind: "outside_paths", files: ["src/components/cipher-tools/dice.tsx", "src/screens/newsreel.tsx"] });
  });

  it("does not take versions or urls for files", () => {
    expect(filesNamed("0.7.9 and https://x.dev/a.ts, ./a/b.ts")).toEqual(["a/b.ts"]);
  });
});
