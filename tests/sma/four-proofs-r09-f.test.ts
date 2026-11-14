// Region 9 · Person and window, batch f (n917 … n933): the pure parts — the attempt log in words, the screen registry (palette, open by event).
// What was produced is also written down with observe(): the region scene sma_r09 compares those values with the cards.
import { describe, expect, it } from "vitest";
import { tailWords } from "../../src/rooms/work-graph";
import { observe } from "./r09-world-f";

const completed = (seq: number, item: Record<string, unknown>) => ({ type: "item/completed", seq, data: { item } });

describe("region 9 · the attempt log", () => {
  it("[sma:m_ws_attempt_log] the tail is the LAST lines of the log: of twelve events only the newest eight are said, oldest of them first, and a smaller number of lines says them all", () => {
    const events = [
      ...Array.from({ length: 4 }, (_, index) => completed(index, { type: "commandExecution", command: `old ${index}` })),
      ...Array.from({ length: 4 }, (_, index) => completed(10 + index, { type: "agentMessage", text: `late ${index}` })),
      ...Array.from({ length: 4 }, (_, index) => completed(20 + index, { type: "fileChange", changes: {} })),
    ];
    const tail = tailWords(events);
    expect(tail).toEqual(["пишет ответ", "пишет ответ", "пишет ответ", "пишет ответ", "правит файл…", "правит файл…", "правит файл…", "правит файл…"]);
    expect(tailWords(events, 5)).toEqual(["пишет ответ", "правит файл…", "правит файл…", "правит файл…", "правит файл…"]);
    expect(tailWords(events.slice(0, 3))).toEqual(["запускает проверку", "запускает проверку", "запускает проверку"]);
    // One call is several events and counts once; a tool the table does not know is not a line.
    const real = [{ type: "item/started", data: { item: { type: "toolCall", tool: "read" } } }, completed(1, { type: "toolCall", tool: "read" }), completed(2, { type: "toolCall", tool: "mystery_tool" }), completed(3, { type: "toolCall", name: "apply_patch" })];
    expect(tailWords(real)).toEqual(["читает файл…", "правит файл…"]);
    observe("n919", { tail, five: tailWords(events, 5), once: tailWords(real) });
  });
});
