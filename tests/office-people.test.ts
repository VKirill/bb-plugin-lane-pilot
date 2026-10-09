import { describe, expect, it } from "vitest";
import {
  OWNER_VARIANT,
  RECEPTIONIST_VARIANT,
  SEAT_HEIGHT_CHAIR,
  SEAT_HEIGHT_SOFA,
  SEAT_HEIGHT_STOOL,
  pickPersonVariant,
  seatHeightForPoint,
} from "../src/rooms/council/ui/office-people";
import { PERSON_VARIANTS } from "@lane-pilot/pixel-world";

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

describe("seatHeightForPoint", () => {
  it("lifts people onto stools and sofas", () => {
    expect(seatHeightForPoint("pt_stool_2", "coffee")).toBe(SEAT_HEIGHT_STOOL);
    expect(seatHeightForPoint("pt_sofa_1", "sofa")).toBe(SEAT_HEIGHT_SOFA);
    expect(seatHeightForPoint("pt_desk_a", "desk")).toBe(SEAT_HEIGHT_CHAIR);
  });
});
