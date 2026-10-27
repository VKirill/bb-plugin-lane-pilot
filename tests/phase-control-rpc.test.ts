import { describe, expect, it } from "vitest";
import { rpcContract } from "../src/rooms/contracts";
import { WORD_TURNS } from "../src/rooms/phase/logic";
import { phaseRpc } from "../src/rooms/phase/server/rpc";

// The owner's word reaches a phase from the cockpit and from Telegram: every turn the driver asks for, and the wave of a wave turn.
describe("phase_control word", () => {
  it("accepts every word turn and the wave, and still refuses unknown fields", () => {
    for (const turn of WORD_TURNS) expect(rpcContract.phase_control.input.safeParse({ phaseId: "ph1", action: "word", turn, decision: "yes" }).success, turn).toBe(true);
    expect(rpcContract.phase_control.input.safeParse({ phaseId: "ph1", action: "word", turn: "wave", decision: "no", note: "redo", wave: 2 }).success).toBe(true);
    expect(rpcContract.phase_control.input.safeParse({ phaseId: "ph1", action: "word", turn: "wave", decision: "no", extra: 1 }).success).toBe(false);
  });
  it("passes the wave to the driver", async () => {
    const seen: unknown[] = [];
    const api = { word: async (input: unknown) => { seen.push(input); return { id: "ph1" }; }, status: (id: string) => ({ id }) } as never;
    await phaseRpc(api).phase_control({ phaseId: "ph1", action: "word", turn: "wave", decision: "no", note: "map is old", wave: 2 } as never);
    expect(seen).toEqual([{ phaseId: "ph1", turn: "wave", decision: "no", text: "map is old", wave: 2, by: "owner via screen" }]);
  });
});
