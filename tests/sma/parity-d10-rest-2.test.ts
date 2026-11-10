import { describe, expect, it, vi } from "vitest";
import { phaseStageCells, PHASE_STAGES } from "../../src/rooms/phase";
import { ceilingLine } from "../../src/rooms/work-graph";
import { tailWords } from "../../src/rooms/work-graph";
import { workerSecretReach } from "../../src/rooms/verification";

const calls: Array<{ program: string; args: string[] }> = [];
vi.mock("@lane-pilot/kit", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, spawnAsync: async (program: string, args: string[]) => {
    calls.push({ program, args });
    // The fixture: ~/.ssh is world-readable to the worker, the 0600 credential file is not.
    return { status: args.includes(`${process.env.HOME}/.ssh`) ? 0 : 1, stdout: "", stderr: "" };
  } };
});

describe("parity d10-rest-2", () => {
  it("[sma:m_ws_stage_graph] phaseStageCells(\"execution\", \"active\") gives discussion, planning, design passed, execution running and the rest pending, eight cells in PHASE_STAGES order", () => {
    const cells = phaseStageCells("execution", "active");
    expect(cells.map((cell) => cell.stageId)).toEqual([...PHASE_STAGES]);
    expect(cells.map((cell) => cell.state)).toEqual(["passed", "passed", "passed", "running", "pending", "pending", "pending", "pending"]);
    expect(phaseStageCells("execution", "stopped")[3]!.state).toBe("failed");
    expect(phaseStageCells("closed", "closed").every((cell) => cell.state === "passed")).toBe(true);
  });

  it("[sma:sc_spend] ceilingLine({turns:4}, {monthUsd:45, cap:50}) names 4 of 5 turns and marks the money over 90 percent; with cap null it shows the spend only", () => {
    const line = ceilingLine({ turns: 4 }, { monthUsd: 45, cap: 50 });
    expect(line.turns).toEqual({ n: 4, max: 5 });
    expect(line.monthUsd).toBe(45);
    expect(line.hot).toBe(true);
    const open = ceilingLine({ turns: null }, { monthUsd: 45, cap: null });
    expect(open.turns).toBeNull();
    expect(open.cap).toBeNull();
    expect(open.hot).toBe(false);
    expect(ceilingLine({ turns: 4 }, { monthUsd: 10, cap: 50 }).hot).toBe(false);
  });

  it("[sma:m_ws_attempt_log] tailWords turns a read call, an edit call and a final message into three Russian lines in order, drops an unknown type, caps at 8 and is empty for no events", () => {
    const event = (item: unknown) => ({ data: { item } });
    const lines = tailWords([
      event({ type: "toolCall", name: "read_file" }),
      event({ type: "mysteryType", name: "x" }),
      event({ type: "toolCall", name: "apply_patch" }),
      event({ type: "agentMessage", text: "done" }),
    ]);
    expect(lines).toEqual(["читает файл…", "правит файл…", "пишет ответ"]);
    const many = Array.from({ length: 12 }, (_, index) => event({ type: "commandExecution", command: `check ${index}` }));
    const capped = tailWords(many);
    expect(capped).toHaveLength(8);
    expect(capped.every((line) => line === "запускает проверку")).toBe(true);
    expect(tailWords([])).toEqual([]);
  });

  it("[sma:m_ac_identity_probe] workerSecretReach names a secret path the worker can read as exposed, a 0600 file as closed, and an invalid user fails without running sudo", async () => {
    calls.length = 0;
    const probe = await workerSecretReach("lp-worker", process.env.HOME!);
    expect(probe.ok).toBe(false);
    expect(probe.reachable).toEqual([`${process.env.HOME}/.ssh`]);
    expect(calls.every((call) => call.args.slice(0, 4).join(" ") === `-n -u lp-worker /usr/bin/test`)).toBe(true);
    await expect(workerSecretReach("root;rm -rf /")).rejects.toThrow(/worker_user_invalid/);
    expect(calls.filter((call) => call.args[2] !== "lp-worker")).toEqual([]);
  });
});
