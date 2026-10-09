import { describe, expect, it } from "vitest";
import {
  OWNER_VARIANT,
  PERSON_SCALE,
  PERSON_VARIANTS,
  RECEPTIONIST_VARIANT,
  SEAT_HEIGHT_CHAIR,
  SEAT_HEIGHT_SOFA,
  SEAT_HEIGHT_STOOL,
  clipForState,
  pickPersonVariant,
  seatHeightForPoint,
  seatPlacement,
  walkTimeScale,
} from "../src/rooms/council/ui/office-people";

describe("pickPersonVariant", () => {
  it("gives the owner and the receptionist their own characters", () => {
    expect(pickPersonVariant("owner", [1, 2])).toBe(OWNER_VARIANT);
    expect(pickPersonVariant("staff_reception", [])).toBe(RECEPTIONIST_VARIANT);
  });

  it("is stable for the same id and floor", () => {
    expect(pickPersonVariant("product", [3])).toBe(pickPersonVariant("product", [3]));
  });

  it("avoids repeats and the reserved variants while the floor has free ones", () => {
    const taken: number[] = [OWNER_VARIANT, RECEPTIONIST_VARIANT];
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) taken.push(pickPersonVariant(id, taken));
    expect(new Set(taken).size).toBe(PERSON_VARIANTS);
  });

  it("repeats only once all eight are in use, and spreads the repeats", () => {
    const taken: number[] = [OWNER_VARIANT, RECEPTIONIST_VARIANT];
    for (let i = 0; i < 12; i++) taken.push(pickPersonVariant(`n${i}`, taken));
    const counts = new Array(PERSON_VARIANTS).fill(0);
    for (const v of taken) counts[v] += 1;
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("does not count the owner twice when his rig is among the others", () => {
    const v = pickPersonVariant("x", [OWNER_VARIANT, RECEPTIONIST_VARIANT]);
    expect([OWNER_VARIANT, RECEPTIONIST_VARIANT]).not.toContain(v);
  });
});

describe("clipForState", () => {
  const idle = { walking: false, sitting: false, activity: "idle" };

  it("walks whenever the person moves", () => {
    expect(clipForState({ ...idle, walking: true, sitting: true })).toBe("Walk");
  });

  it("types at desks and sits elsewhere", () => {
    expect(clipForState({ ...idle, sitting: true, action: "typing" })).toBe("SitType");
    expect(clipForState({ ...idle, sitting: true })).toBe("Sit");
    expect(clipForState({ ...idle, sitting: true, action: "coffee" })).toBe("Sit");
  });

  it("sits at the meeting table and talks now and then", () => {
    expect(clipForState({ walking: false, sitting: true, activity: "waiting", slot: 1 })).toBe("Sit");
    expect(clipForState({ walking: false, sitting: true, activity: "waiting", slot: 4 })).toBe("SitTalk");
  });

  it("maps the council activities", () => {
    expect(clipForState({ walking: false, sitting: false, activity: "speaking" })).toBe("Talk");
    expect(clipForState({ walking: false, sitting: false, activity: "arguing" })).toBe("Point");
  });

  it("maps the standing office actions", () => {
    const standing = (action?: string) => clipForState({ ...idle, action });
    expect(standing("chat")).toBe("Talk");
    expect(standing("coffee")).toBe("Drink");
    expect(standing("bar")).toBe("Drink");
    expect(standing("operate")).toBe("Interact");
    expect(standing("window")).toBe("Window");
    expect(standing(undefined)).toBe("Idle");
  });
});

describe("walkTimeScale and seat placement", () => {
  it("speeds the walk cycle up with the ground speed", () => {
    expect(walkTimeScale(3.5)).toBeGreaterThan(walkTimeScale(2));
    expect(walkTimeScale(2) / walkTimeScale(1)).toBeCloseTo(2);
    expect(walkTimeScale(2, PERSON_SCALE * 2)).toBeCloseTo(walkTimeScale(2) / 2);
  });

  it("puts the pelvis on the seat: higher seats lift the person, every character stays above the floor", () => {
    expect(seatHeightForPoint("pt_stool_2", "coffee")).toBe(SEAT_HEIGHT_STOOL);
    expect(seatHeightForPoint("pt_sofa_1", "sofa")).toBe(SEAT_HEIGHT_SOFA);
    expect(seatHeightForPoint("pt_desk_a", "desk")).toBe(SEAT_HEIGHT_CHAIR);
    for (let v = 0; v < PERSON_VARIANTS; v++) {
      const chair = seatPlacement(v, SEAT_HEIGHT_CHAIR);
      expect(chair.y).toBeGreaterThan(0);
      expect(chair.z).toBeGreaterThan(0);
      expect(seatPlacement(v, SEAT_HEIGHT_STOOL).y).toBeGreaterThan(chair.y);
    }
  });
});
