import { describe, expect, it } from "vitest";
import { createManualMode, parseManualMode } from "../src/rooms/contracts";
import { createManualModeService } from "../src/rooms/owner-waiting/server";

const memoryKv = () => {
  const map = new Map<string, unknown>();
  return { get: async (key: string) => map.get(key), set: async (key: string, value: unknown) => { map.set(key, value); } };
};

const fakeBrakes = () => {
  const state = { schedules: false, conveyorOn: true, graphs: false, staff: false };
  const port = (key: "schedules" | "graphs" | "staff") => ({
    getState: async () => ({ paused: state[key], since: null, reason: null }),
    setState: async (paused: boolean) => { state[key] = paused; return { paused, since: null, reason: null }; },
  });
  return {
    state,
    deps: {
      schedules: { ...port("schedules"), activeCount: () => 0 },
      graphs: { ...port("graphs"), triggeredCount: () => 0 },
      staff: { ...port("staff"), activeSpecialistCount: () => 0 },
      conveyor: {
        getState: async () => ({ on: state.conveyorOn, since: null, reason: null }),
        setState: async (on: boolean) => { state.conveyorOn = on; return { on, since: null, reason: null }; },
        queuedCount: () => 0,
      },
    },
  };
};

describe("manual mode", () => {
  it("is on when nothing was saved, and keeps what the owner saved", async () => {
    expect(parseManualMode(undefined).on).toBe(true);
    const kv = memoryKv();
    const mode = createManualMode(kv, () => 5);
    expect((await mode.load()).on).toBe(true);
    await mode.set(false, "go");
    expect((await createManualMode(kv).load())).toEqual({ on: false, since: 5, reason: "go" });
    expect((await createManualMode(memoryKv()).load(false)).on).toBe(false);
    expect((await createManualMode(kv).load(true)).on).toBe(false);
    const broken = createManualMode({ get: async () => { throw new Error("kv down"); }, set: async () => undefined });
    await expect(broken.load(false)).rejects.toThrow("kv down");
    expect(broken.on()).toBe(true);
  });

  it("holds all four brakes at start while manual, and nothing when the owner turned it off", async () => {
    const brakes = fakeBrakes();
    const manual = createManualMode(memoryKv());
    await manual.load();
    const service = createManualModeService({ manualMode: manual, brakes: brakes.deps });
    await service.holdAtStart();
    expect(brakes.state).toEqual({ schedules: true, conveyorOn: false, graphs: true, staff: true });

    const off = fakeBrakes();
    const offMode = createManualMode(memoryKv());
    await offMode.set(false);
    await createManualModeService({ manualMode: offMode, brakes: off.deps }).holdAtStart();
    expect(off.state).toEqual({ schedules: false, conveyorOn: true, graphs: false, staff: false });
  });

  it("off lifts the brakes and runs the skipped resume once; on sets them again", async () => {
    const brakes = fakeBrakes();
    let resumed = 0;
    const manual = createManualMode(memoryKv());
    await manual.load();
    const service = createManualModeService({ manualMode: manual, brakes: brakes.deps, resumeWork: async () => { resumed++; } });
    await service.holdAtStart();
    const view = await service.set({ on: false });
    expect(view.on).toBe(false);
    expect(view.brakes.every((brake) => !brake.paused)).toBe(true);
    expect(resumed).toBe(1);
    await service.set({ on: true, reason: "quiet" });
    expect(brakes.state).toEqual({ schedules: true, conveyorOn: false, graphs: true, staff: true });
    expect(resumed).toBe(1);
  });
});
