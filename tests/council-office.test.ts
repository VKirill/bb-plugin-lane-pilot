import { describe, expect, it } from "vitest";
import {
  assignOfficeSeats,
  assignSeatColors,
  chooseIdleSpot,
  deriveOfficeActors,
  findOfficePath,
  formatBubbleText,
  getOfficePose,
  isFloorBlocked,
  isLineSegmentBlocked,
  nextWanderTarget,
  seatColor,
  stripMarkdown,
  walkStep,
  OFFICE_OBSTACLES,
  OFFICE_SEATS,
  OFFICE_SPOTS,
  type CouncilDetailLike,
  type OfficeActor,
} from "../src/rooms/council/ui/office-behaviour";

describe("seatColor", () => {
  it("returns stable designated colors for special seats", () => {
    expect(seatColor("owner")).toBe("#e11d48");
    expect(seatColor("chair")).toBe("#64748b");
    expect(seatColor("moderator")).toBe("#71717a");
  });

  it("returns stable palette colors for dynamic seats", () => {
    const c1 = seatColor("skeptic");
    const c2 = seatColor("skeptic");
    expect(c1).toBe(c2);
    expect(typeof c1).toBe("string");
  });

  it("assigns distinct colors to all seats of a council without collisions", () => {
    const seats = [
      { id: "product" },
      { id: "skeptic" },
      { id: "growth" },
      { id: "finance" },
      { id: "design" },
    ];
    const colors = seats.map((s) => seatColor(s.id, seats));
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(seats.length);

    const map = assignSeatColors(seats);
    expect(map.size).toBe(seats.length);
  });
});

describe("stripMarkdown & formatBubbleText", () => {
  it("strips headers, bold, italics, code and blockquotes", () => {
    const markdown = "### Proposal\n\n**Bold text** with *italic* and `inline code`.\n> Important quote!\n- List item 1";
    const stripped = stripMarkdown(markdown);
    expect(stripped).not.toContain("###");
    expect(stripped).not.toContain("**");
    expect(stripped).not.toContain("`");
    expect(stripped).not.toContain(">");
    expect(stripped).toContain("Bold text with italic and inline code.");
    expect(stripped).toContain("Important quote!");
  });

  it("strips links and keeps link text", () => {
    const textWithLink = "Check [our dashboard](https://example.com/metrics) for details.";
    expect(stripMarkdown(textWithLink)).toBe("Check our dashboard for details.");
  });

  it("truncates with ellipsis when longer than limit", () => {
    const longText = "This is a very long speech from one of the council members about architecture and conversion.";
    const bubble = formatBubbleText(longText, 40);
    expect(bubble.length).toBeLessThanOrEqual(40);
    expect(bubble.endsWith("…")).toBe(true);
  });
});

describe("nextWanderTarget", () => {
  it("deterministic with seeded rng and never returns current", () => {
    const points = ["desk1", "desk2", "coffee", "bookshelf", "window", "plant"];
    let seed = 42;
    const fakeRng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };

    let current = "desk1";
    for (let i = 0; i < 20; i++) {
      const next = nextWanderTarget(fakeRng, current, points);
      expect(next).not.toBe(current);
      expect(points).toContain(next);
      current = next;
    }
  });

  it("handles empty or single point lists", () => {
    expect(nextWanderTarget(() => 0.5, "desk1", [])).toBe("");
    expect(nextWanderTarget(() => 0.5, "desk1", ["desk1"])).toBe("desk1");
  });
});

describe("findOfficePath & obstacles", () => {
  it("correctly identifies obstacles as blocked floor cells", () => {
    // Table center (0, 0) is blocked
    expect(isFloorBlocked(0, 0)).toBe(true);
    // Desk 1 center (-3.6, -2.5) is blocked
    expect(isFloorBlocked(-3.6, -2.5)).toBe(true);
    // Coffee counter (4.2, 3.8) is blocked
    expect(isFloorBlocked(4.2, 3.8)).toBe(true);

    // Free floor aisle
    expect(isFloorBlocked(0, 3.0)).toBe(false);
    expect(isFloorBlocked(0, -3.0)).toBe(false);
  });

  it("path finding navigates around the table and never goes through blocked furniture", () => {
    const start = { x: -3.5, z: 0 }; // West of table
    const target = { x: 3.5, z: 0 }; // East of table

    const path = findOfficePath(start, target);
    expect(path.length).toBeGreaterThan(0);

    // Verify destination reached
    const endPoint = path[path.length - 1]!;
    expect(Math.hypot(endPoint.x - target.x, endPoint.z - target.z)).toBeLessThan(0.1);

    // Every waypoint must be on unblocked floor
    for (const pt of path) {
      expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
    }

    // Verify intermediate path segments do not cut through the table
    let curr = start;
    for (const pt of path) {
      expect(isLineSegmentBlocked(curr.x, curr.z, pt.x, pt.z)).toBe(false);
      curr = pt;
    }
  });

  it("path finding finds a clear route between desk and coffee corner", () => {
    const start = { x: -3.6, z: -1.4 }; // Desk 1 spot
    const target = { x: 2.9, z: 3.8 };  // Coffee spot

    const path = findOfficePath(start, target);
    expect(path.length).toBeGreaterThan(0);

    for (const pt of path) {
      expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
    }
  });

  it("proves every seat and wander spot is on unblocked floor and mutually reachable", () => {
    // Check every seat is unblocked
    for (const seat of OFFICE_SEATS) {
      expect(isFloorBlocked(seat.x, seat.z)).toBe(false);
      expect(isFloorBlocked(seat.speakX, seat.speakZ)).toBe(false);
    }

    // Check every wander spot is unblocked
    const spotList = Object.values(OFFICE_SPOTS);
    for (const spot of spotList) {
      expect(isFloorBlocked(spot.x, spot.z)).toBe(false);
    }

    // Test reachability between seats and wander spots
    const centerAisle = { x: 0, z: 2.5 };
    for (const seat of OFFICE_SEATS) {
      const pathToCenter = findOfficePath({ x: seat.x, z: seat.z }, centerAisle);
      expect(pathToCenter.length).toBeGreaterThan(0);
      for (const pt of pathToCenter) {
        expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
      }
    }

    for (const spot of spotList) {
      const pathToCenter = findOfficePath({ x: spot.x, z: spot.z }, centerAisle);
      expect(pathToCenter.length).toBeGreaterThan(0);
      for (const pt of pathToCenter) {
        expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
      }
    }
  });
});

describe("walkStep", () => {
  it("moves at most speed * dt per frame and does not jump", () => {
    const current = { x: 0, z: 0 };
    const target = { x: 10, z: 0 };
    const speed = 2.0;
    const dt = 0.05;
    const maxExpectedDist = speed * dt; // 0.1

    const step = walkStep(current, target, speed, dt);
    expect(step.reached).toBe(false);

    const actualDist = Math.hypot(step.x - current.x, step.z - current.z);
    expect(actualDist).toBeCloseTo(maxExpectedDist, 5);
    expect(step.x).toBeCloseTo(0.1, 5);
    expect(step.z).toBe(0);
    expect(step.heading).toBeCloseTo(Math.PI / 2, 4); // heading towards +x
  });

  it("reaches target cleanly when remaining distance is within max step", () => {
    const current = { x: 2.95, z: 1.0 };
    const target = { x: 3.0, z: 1.0 };
    const speed = 2.0;
    const dt = 0.1; // maxStep = 0.2, dist = 0.05

    const step = walkStep(current, target, speed, dt);
    expect(step.reached).toBe(true);
    expect(step.x).toBe(target.x);
    expect(step.z).toBe(target.z);
  });
});

describe("assignOfficeSeats", () => {
  it("assigns unique seats to each actor with no overlap", () => {
    const actors = [
      { id: "chair" },
      { id: "owner" },
      { id: "skeptic" },
      { id: "product" },
      { id: "finance" },
    ];

    const seats = assignOfficeSeats(actors);
    expect(seats.size).toBe(5);

    const assignedIds = new Set<string>();
    const assignedCoords = new Set<string>();

    for (const [actorId, seat] of seats.entries()) {
      expect(assignedIds.has(seat.id)).toBe(false);
      assignedIds.add(seat.id);

      const coordKey = `${seat.x.toFixed(2)},${seat.z.toFixed(2)}`;
      expect(assignedCoords.has(coordKey)).toBe(false);
      assignedCoords.add(coordKey);
    }

    // Chair gets west head seat
    expect(seats.get("chair")?.x).toBe(OFFICE_SEATS[0]?.x);
    // Owner gets east head seat
    expect(seats.get("owner")?.x).toBe(OFFICE_SEATS[1]?.x);
  });
});

describe("chooseIdleSpot", () => {
  it("never selects an occupied spot", () => {
    const occupied = new Set(["desk1", "desk2", "coffee", "bookshelf", "window", "plant1"]);
    const chosen = chooseIdleSpot(occupied, () => 0.5, null);

    expect(chosen).toBeDefined();
    expect(occupied.has(chosen!)).toBe(false);
  });

  it("avoids current spot when alternatives exist", () => {
    const occupied = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const chosen = chooseIdleSpot(occupied, () => 0.1, "desk1");
      expect(chosen).not.toBe("desk1");
    }
  });
});

describe("getOfficePose", () => {
  it("returns sitting pose for waiting activity", () => {
    const pose = getOfficePose("waiting");
    expect(pose.sitting).toBe(true);
    expect(pose.bodyY).toBeLessThan(0.8);
    expect(pose.leftLegPitch).toBeCloseTo(Math.PI / 2, 2);
    expect(pose.rightLegPitch).toBeCloseTo(Math.PI / 2, 2);
    expect(pose.pointing).toBe(false);
  });

  it("returns standing and gesturing pose for speaking activity", () => {
    const pose = getOfficePose("speaking", { tick: 1.0 });
    expect(pose.sitting).toBe(false);
    expect(pose.bodyY).toBeGreaterThanOrEqual(0.85);
    expect(pose.leftLegPitch).toBe(0);
    expect(pose.pointing).toBe(false);
    // Arms gesture
    expect(pose.leftArmPitch).not.toBe(0);
  });

  it("returns pointing pose for arguing activity", () => {
    const pose = getOfficePose("arguing", { tick: 1.0 });
    expect(pose.sitting).toBe(false);
    expect(pose.pointing).toBe(true);
    // Right arm is extended forward pointing
    expect(pose.rightArmPitch).toBeCloseTo(-Math.PI / 2, 1);
  });

  it("returns walking leg and arm swings when isWalking is true", () => {
    const pose = getOfficePose("waiting", { tick: 0.5, isWalking: true });
    expect(pose.sitting).toBe(false);
    expect(pose.leftLegPitch).not.toBe(0);
    expect(pose.rightLegPitch).not.toBe(0);
    expect(pose.leftLegPitch).toBeCloseTo(-pose.rightLegPitch, 4); // opposing swing
  });
});

describe("deriveOfficeActors", () => {
  const baseDetail: CouncilDetailLike = {
    id: "cncl_1",
    state: "discussion",
    speaking: "skeptic",
    speakingSince: 1000,
    seats: [
      { id: "product", title: "Product director" },
      { id: "skeptic", title: "Skeptic" },
    ],
    messages: [
      { seq: 1, seatId: "chair", round: 0, kind: "agenda", text: "Welcome to council." },
      { seq: 2, seatId: "product", round: 1, kind: "position", text: "We should focus on conversion." },
      { seq: 3, seatId: "skeptic", round: 1, kind: "reply", text: "Conversion is fine, retention is broken." },
    ],
  };

  it("live speaker gets speaking + bubble from its latest message; others waiting", () => {
    const actors = deriveOfficeActors(baseDetail, null, 2000);
    const skeptic = actors.find((a: OfficeActor) => a.id === "skeptic")!;
    const product = actors.find((a: OfficeActor) => a.id === "product")!;
    const chair = actors.find((a: OfficeActor) => a.id === "chair")!;

    expect(skeptic.activity).toBe("arguing"); // reply kind in latest message
    expect(skeptic.bubble).toContain("Conversion is fine");
    expect(skeptic.facing).toBe("product");

    expect(product.activity).toBe("waiting");
    expect(chair.activity).toBe("waiting");
  });

  it("live speaker writing without previous message gets '…' bubble", () => {
    const detailWithoutSkepticMsg: CouncilDetailLike = {
      ...baseDetail,
      speaking: "skeptic",
      messages: [
        { seq: 1, seatId: "chair", round: 0, kind: "agenda", text: "Welcome to council." },
      ],
    };
    const actors = deriveOfficeActors(detailWithoutSkepticMsg, null, 2000);
    const skeptic = actors.find((a: OfficeActor) => a.id === "skeptic")!;
    expect(skeptic.activity).toBe("speaking");
    expect(skeptic.bubble).toBe("…");
  });

  it("terminal council at live cursor → all idle (wandering)", () => {
    const terminalDetail: CouncilDetailLike = {
      ...baseDetail,
      state: "done",
      speaking: null,
    };
    const actors = deriveOfficeActors(terminalDetail, null, 2000);
    for (const actor of actors) {
      expect(actor.activity).toBe("idle");
    }
  });

  it("no speaker for >20s in live council → all idle", () => {
    const idleDetail: CouncilDetailLike = {
      ...baseDetail,
      speaking: null,
      speakingSince: 1000,
    };
    const actors = deriveOfficeActors(idleDetail, null, 25000); // 24s later
    for (const actor of actors) {
      expect(actor.activity).toBe("idle");
    }
  });

  it("owner actor only appears when an owner message exists up to cursor", () => {
    // No owner message initially
    const actorsWithoutOwner = deriveOfficeActors(baseDetail, null, 2000);
    expect(actorsWithoutOwner.find((a: OfficeActor) => a.id === "owner")).toBeUndefined();

    // With owner message
    const detailWithOwner: CouncilDetailLike = {
      ...baseDetail,
      messages: [
        { seq: 1, seatId: "owner", round: 0, kind: "owner", text: "What is our strategy?" },
        ...baseDetail.messages,
      ],
    };
    const actorsWithOwner = deriveOfficeActors(detailWithOwner, null, 2000);
    expect(actorsWithOwner.find((a: OfficeActor) => a.id === "owner")).toBeDefined();

    // Replay cursor before owner message
    const replayBeforeOwner = deriveOfficeActors(detailWithOwner, 1, 2000);
    expect(replayBeforeOwner.find((a: OfficeActor) => a.id === "owner")).toBeDefined();
  });

  it("replay cursor on an older message makes that message's author the speaker with that text", () => {
    const detailWithOwner: CouncilDetailLike = {
      ...baseDetail,
      messages: [
        { seq: 1, seatId: "chair", round: 0, kind: "agenda", text: "Welcome to council." },
        { seq: 2, seatId: "product", round: 1, kind: "position", text: "We should focus on conversion." },
        { seq: 3, seatId: "skeptic", round: 1, kind: "reply", text: "Conversion is fine, retention is broken." },
      ],
    };

    // Cursor at seq 2 (product spoke)
    const actors = deriveOfficeActors(detailWithOwner, 2, 2000);
    const product = actors.find((a: OfficeActor) => a.id === "product")!;
    const skeptic = actors.find((a: OfficeActor) => a.id === "skeptic")!;
    const chair = actors.find((a: OfficeActor) => a.id === "chair")!;

    expect(product.activity).toBe("speaking");
    expect(product.bubble).toBe("We should focus on conversion.");
    expect(skeptic.activity).toBe("waiting");
    expect(chair.activity).toBe("waiting");
  });

  it("replay reply message sets arguing and faces the answered seat", () => {
    const actors = deriveOfficeActors(baseDetail, 3, 2000);
    const skeptic = actors.find((a: OfficeActor) => a.id === "skeptic")!;
    expect(skeptic.activity).toBe("arguing");
    expect(skeptic.facing).toBe("product");
  });
});
