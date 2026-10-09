import { describe, expect, it } from "vitest";
import { PERSON_SCALE, PERSON_VARIANTS, clipForState, seatPlacement, walkTimeScale } from "../src/index";

const CHAIR = 0.52;
const STOOL = 0.7;

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
    for (let v = 0; v < PERSON_VARIANTS; v++) {
      const chair = seatPlacement(v, CHAIR);
      expect(chair.y).toBeGreaterThan(0);
      expect(chair.z).toBeGreaterThan(0);
      expect(seatPlacement(v, STOOL).y).toBeGreaterThan(chair.y);
    }
  });
});
