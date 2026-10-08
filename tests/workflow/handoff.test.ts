import { describe, expect, it } from "vitest";
import { INLINE_CHARS, PACKET_BYTES, planPacket, refPath, startPacket } from "../../src/workflow/handoff";

/** The start packet and the references that stand for big inputs (W0, L10). */
const step = { id: "audit", role: "analyst", mode: "standard" };
const plan = (inputs: Array<{ name: string; value: unknown }>, extra: Record<string, unknown> = {}) =>
  planPacket({ step, chatId: "thr_1", runId: "wfrun_abc", inputs, ...extra });
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the start packet", () => {
  it("lists small inputs inline, in one line each, and has the goal, what to produce and the gates", () => {
    const { packet, files } = plan([{ name: "goal", value: "Add a flag" }, { name: "scope", value: "src/export" }], {
      goal: "Add a flag", goalInput: "goal", produces: [{ kind: "findings", version: 1 }], gates: ["audit.count >= 0"],
    });
    expect(files).toEqual([]);
    expect(packet.startsWith("<step-packet>\nStep: audit (analyst); quality mode standard.\nGoal: Add a flag\nInputs:\n- scope: src/export\n")).toBe(true);
    expect(packet).toContain("Produce:\n- findings/1 as the whole answer; needs findings\n  example: {\"findings\"");
    expect(packet).toContain("Gates (all must hold):\n- audit.count >= 0");
    expect(packet.endsWith("</step-packet>")).toBe(true);
    // The goal is on its own line and not listed twice.
    expect(packet).not.toContain("- goal:");
  });

  it("an input over the inline limit stands as a path and a summary; the file holds the value as it is", () => {
    const list = Array.from({ length: 30 }, (_, at) => ({ id: `F${at}`, title: `Finding ${at}`, evidence: "e".repeat(40) }));
    const { packet, files, refs } = plan([{ name: "findings", value: list }, { name: "text", value: "t".repeat(INLINE_CHARS + 1) }]);
    expect(Object.keys(refs)).toEqual(["findings", "text"]);
    expect(files.map((file) => file.path)).toEqual([refs.findings!.path, refs.text!.path]);
    expect(JSON.parse(files[0]!.text)).toEqual(list);
    expect(files[1]!.text).toBe("t".repeat(INLINE_CHARS + 1));
    expect(packet).toContain("list of 30: Finding 0; Finding 1; Finding 2; ...");
    expect(packet).toContain(`file: ${refs.findings!.path}`);
    expect(refs.findings!.path).toMatch(/^\.bb\/chats\/thr_1\/artifacts\/wf-wfrun_abc\/findings\.[0-9a-f]{8}\.json$/);
    expect(refs.text!.path).toMatch(/\/text\.[0-9a-f]{8}\.txt$/);
    expect(packet).not.toContain("Finding 17");
  });

  it("the same value always has the same path, another value another; the path is safe", () => {
    expect(refPath("c", "r", "tasks", [1, 2])).toBe(refPath("c", "r", "tasks", [1, 2]));
    expect(refPath("c", "r", "tasks", [1, 2])).not.toBe(refPath("c", "r", "tasks", [1, 3]));
    expect(refPath("c", "r", "../../etc/passwd", "x")).not.toContain("..");
    expect(refPath("c", "r", "ключ", "x")).toMatch(/\/input\.[0-9a-f]{8}\.txt$/);
  });

  it("stays within about 3 KB however much it is given: a long goal, a long gate list, many inputs, Russian text", () => {
    const inputs = Array.from({ length: 40 }, (_, at) => ({ name: `вход${at}`, value: `значение ${at} `.repeat(30) }));
    const gates = Array.from({ length: 10 }, (_, at) => `audit.field${at} >= ${at} && audit.other${at} != 'x'`.padEnd(300, " "));
    const result = plan([{ name: "goal", value: "цель ".repeat(500) }, ...inputs], { goal: "цель ".repeat(500), goalInput: "goal", gates, produces: [{ kind: "task", version: 2, field: "tasks", each: true }, { kind: "verdict", version: 1 }] });
    expect(bytes(result.packet)).toBeLessThanOrEqual(PACKET_BYTES);
    // Nothing the step was given is lost: what does not fit is in the file.
    const kept = JSON.parse(result.files.at(-1)!.text) as Record<string, string>;
    expect(Object.keys(kept)).toContain("вход39");
    expect(result.packet).toContain("Produce:");
    expect(result.packet).toContain("Gates (all must hold):");
  });

  it("without references (the files could not be written) every input is shown, cut", () => {
    const result = plan([{ name: "tasks", value: "z".repeat(5000) }], { byReference: false });
    expect(result.files).toEqual([]);
    expect(result.packet).toContain("(cut)");
    expect(result.packet).not.toContain("by reference");
    expect(bytes(result.packet)).toBeLessThanOrEqual(PACKET_BYTES);
  });

  it("the last resort keeps the closing tag and says that something was cut", () => {
    const text = startPacket({ step, inputs: Array.from({ length: 80 }, (_, at) => ({ name: `i${at}`, value: "v" })), refs: {}, budget: 600 });
    expect(bytes(text)).toBeLessThanOrEqual(600);
    expect(text).toContain("[more cut]");
    expect(text.endsWith("</step-packet>")).toBe(true);
  });
});
