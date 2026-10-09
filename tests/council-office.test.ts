import { describe, expect, it } from "vitest";
import {
  ALL_INTERACTION_POINTS,
  OFFICE_PROPS,
  OFFICE_SPOTS,
  OFFICE_WALLS,
  OWNER_SPOTS,
  OWNER_SEAT_ID,
  OFFICE_SEATS,
  createOfficeAgents,
  findOfficeFloorPath,
  getInteractionPoint,
  isOfficeFloorBlocked,
  isOfficeSegmentBlocked,
  stepOfficeSimulation,
  type OfficeSimAgent,
} from "../src/rooms/council/ui/office-layout";
import {
  assignOfficeSeats,
  assignSeatColors,
  chooseIdleSpot,
  deriveOfficeActors,
  findOfficePath,
  fitOfficeCamera,
  formatBubbleText,
  getOfficePose,
  isFloorBlocked,
  isLineSegmentBlocked,
  nextWanderTarget,
  resolveLabelCollisions,
  seatColor,
  stripMarkdown,
  walkStep,
  type CouncilDetailLike,
  type OfficeActor,
} from "../src/rooms/council/ui/office-behaviour";

/** Grid (gx, gz) as world x/z, the way the layout authors it. */
const world = (gx: number, gz: number) => ({ x: gx - 20, z: gz - 10 });
/** Corridor point just south of the meeting room, reachable from everywhere on the floor. */
const CORRIDOR = world(20, 12);

function makeRng(seedStart: number) {
  let seed = seedStart;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

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
    expect(new Set(colors).size).toBe(seats.length);

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
    const rng = makeRng(42);
    let current = "desk1";
    for (let i = 0; i < 20; i++) {
      const next = nextWanderTarget(rng, current, points);
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

describe("office floor: the 40×20 grid", () => {
  it("has the 10 meeting chairs: chair head, owner head, four north and four south", () => {
    expect(OFFICE_SEATS).toHaveLength(10);
    const chairProps = OFFICE_PROPS.filter((p) => p.kind === "meeting_chair");
    expect(chairProps).toHaveLength(10);
    for (const seat of OFFICE_SEATS) {
      // Meeting room: gx 0–12, gz 0–11 (world x −20…−8, z −10…1)
      expect(seat.x).toBeGreaterThan(-20);
      expect(seat.x).toBeLessThan(-8);
      expect(seat.z).toBeLessThan(1);
    }
  });

  it("keeps the speaker spot free", () => {
    for (const seat of OFFICE_SEATS) {
      expect(isOfficeFloorBlocked(seat.speakX, seat.speakZ)).toBe(false);
    }
  });

  it("places the 8 open-space desks as 8 unique interaction points", () => {
    const deskPoints = ALL_INTERACTION_POINTS.filter((p) => p.kind === "desk");
    expect(deskPoints).toHaveLength(8);
    expect(new Set(deskPoints.map((p) => p.id)).size).toBe(8);
    for (const point of deskPoints) {
      expect(isOfficeFloorBlocked(point.x, point.z)).toBe(false);
    }
  });

  it("keeps every wall segment inside the floor", () => {
    for (const wall of OFFICE_WALLS) {
      expect(wall.minX).toBeGreaterThanOrEqual(-20);
      expect(wall.maxX).toBeLessThanOrEqual(20);
      expect(wall.minZ).toBeGreaterThanOrEqual(-10);
      expect(wall.maxZ).toBeLessThanOrEqual(10);
    }
  });

  it("makes every seat, desk, director's office spot (H/W/B) and report spot reachable", () => {
    const targets = [
      ...OFFICE_SEATS.map((seat) => ({ x: seat.x, z: seat.z })),
      ...ALL_INTERACTION_POINTS.filter((p) => p.kind === "desk" || p.kind === "report" || p.kind === "director_chair" || p.kind === "window" || p.kind === "bar").map((p) => ({ x: p.x, z: p.z })),
    ];
    for (const target of targets) {
      const path = findOfficeFloorPath(CORRIDOR, target);
      expect(path.length).toBeGreaterThan(0);
      const end = path[path.length - 1]!;
      expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThan(0.6);
    }
  });

  it("keeps the owner's home, window and bar spots reserved for him", () => {
    expect(Object.keys(OWNER_SPOTS).sort()).toEqual(["pt_director_bar", "pt_director_chair", "pt_director_window"]);
    for (const key of Object.keys(OFFICE_SPOTS)) {
      expect(OWNER_SPOTS[key]).toBeUndefined();
    }
    const home = getInteractionPoint("pt_director_chair")!;
    expect(home.assignedTo).toBe(OWNER_SEAT_ID);
  });

  it("proves every interaction point is on free floor and reachable without crossing furniture", () => {
    for (const point of ALL_INTERACTION_POINTS) {
      expect(isOfficeFloorBlocked(point.x, point.z)).toBe(false);
      const path = findOfficeFloorPath({ x: point.x, z: point.z }, CORRIDOR);
      expect(path.length).toBeGreaterThan(0);
      for (const step of path) {
        expect(isOfficeFloorBlocked(step.x, step.z)).toBe(false);
      }
    }
  });
});

describe("findOfficePath & obstacles", () => {
  it("correctly identifies blocked floor cells", () => {
    // Meeting table centre, grid (6, 5)
    expect(isFloorBlocked(world(6, 5).x, world(6, 5).z)).toBe(true);
    // Desk a1 centre, grid (15, 3.5)
    expect(isFloorBlocked(world(15, 3.5).x, world(15, 3.5).z)).toBe(true);
    // Bar in the director's office, grid (38, 8)
    expect(isFloorBlocked(world(38, 8).x, world(38, 8).z)).toBe(true);
    // Open corridor, grid (20, 12)
    expect(isFloorBlocked(CORRIDOR.x, CORRIDOR.z)).toBe(false);
  });

  it("paths around the meeting table and never goes through furniture", () => {
    const start = world(3, 1.5);
    const target = world(3, 8.5);

    const path = findOfficePath(start, target);
    expect(path.length).toBeGreaterThan(0);

    const endPoint = path[path.length - 1]!;
    expect(Math.hypot(endPoint.x - target.x, endPoint.z - target.z)).toBeLessThan(0.1);

    for (const pt of path) {
      expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
    }

    let curr = start;
    for (const pt of path) {
      expect(isLineSegmentBlocked(curr.x, curr.z, pt.x, pt.z)).toBe(false);
      curr = pt;
    }
  });

  it("walks from the director's chair out through the office door to the corridor without crossing the desk", () => {
    const home = getInteractionPoint("pt_director_chair")!;
    const door = world(34.8, 11.5);
    const path = findOfficePath({ x: home.x, z: home.z }, door);
    expect(path.length).toBeGreaterThan(0);
    for (const pt of path) {
      expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
    }
  });

  it("the speaking spot is reachable from every meeting seat", () => {
    for (const seat of OFFICE_SEATS) {
      const path = findOfficePath({ x: seat.x, z: seat.z }, { x: seat.speakX, z: seat.speakZ });
      expect(path.length).toBeGreaterThan(0);
      for (const pt of path) {
        expect(isFloorBlocked(pt.x, pt.z)).toBe(false);
      }
    }
  });

  it("the wall segments block the door-less parts of the director's office", () => {
    // Crossing the director's west wall (gx 26) away from the doorway is blocked
    const a = world(24, 5);
    const b = world(28, 5);
    expect(isOfficeSegmentBlocked(a.x, a.z, b.x, b.z)).toBe(true);
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
    expect(step.heading).toBeCloseTo(Math.PI / 2, 4);
  });

  it("reaches target cleanly when remaining distance is within max step", () => {
    const current = { x: 2.95, z: 1.0 };
    const target = { x: 3.0, z: 1.0 };
    const step = walkStep(current, target, 2.0, 0.1);
    expect(step.reached).toBe(true);
    expect(step.x).toBe(target.x);
    expect(step.z).toBe(target.z);
  });
});

describe("assignOfficeSeats", () => {
  it("assigns unique seats to each actor with no overlap, chair and owner first", () => {
    const actors = [{ id: "chair" }, { id: "owner" }, { id: "skeptic" }, { id: "product" }, { id: "finance" }];
    const seats = assignOfficeSeats(actors);
    expect(seats.size).toBe(5);

    const assignedIds = new Set<string>();
    for (const seat of seats.values()) {
      expect(assignedIds.has(seat.id)).toBe(false);
      assignedIds.add(seat.id);
    }

    expect(seats.get("chair")?.id).toBe(OFFICE_SEATS[0]?.id);
    expect(seats.get("owner")?.id).toBe(OFFICE_SEATS[1]?.id);
  });
});

describe("chooseIdleSpot", () => {
  it("never selects an occupied spot", () => {
    const occupied = new Set(Object.keys(OFFICE_SPOTS).slice(0, 6));
    const chosen = chooseIdleSpot(occupied, () => 0.5, null);
    expect(chosen).toBeDefined();
    expect(occupied.has(chosen!)).toBe(false);
  });

  it("avoids current spot when alternatives exist", () => {
    const occupied = new Set<string>();
    const current = Object.keys(OFFICE_SPOTS)[0]!;
    for (let i = 0; i < 10; i++) {
      const chosen = chooseIdleSpot(occupied, () => 0.1, current);
      expect(chosen).not.toBe(current);
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
    expect(pose.leftArmPitch).not.toBe(0);
  });

  it("returns pointing pose for arguing activity", () => {
    const pose = getOfficePose("arguing", { tick: 1.0 });
    expect(pose.sitting).toBe(false);
    expect(pose.pointing).toBe(true);
    expect(pose.rightArmPitch).toBeCloseTo(-Math.PI / 2, 1);
  });

  it("returns walking leg and arm swings when isWalking is true", () => {
    const pose = getOfficePose("waiting", { tick: 0.5, isWalking: true });
    expect(pose.sitting).toBe(false);
    expect(pose.leftLegPitch).not.toBe(0);
    expect(pose.rightLegPitch).not.toBe(0);
    expect(pose.leftLegPitch).toBeCloseTo(-pose.rightLegPitch, 4);
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

    expect(skeptic.activity).toBe("arguing");
    expect(skeptic.bubble).toContain("Conversion is fine");
    expect(skeptic.facing).toBe("product");
    expect(product.activity).toBe("waiting");
    expect(chair.activity).toBe("waiting");
  });

  it("live speaker writing without previous message gets '…' bubble", () => {
    const detailWithoutSkepticMsg: CouncilDetailLike = {
      ...baseDetail,
      messages: [{ seq: 1, seatId: "chair", round: 0, kind: "agenda", text: "Welcome to council." }],
    };
    const actors = deriveOfficeActors(detailWithoutSkepticMsg, null, 2000);
    const skeptic = actors.find((a: OfficeActor) => a.id === "skeptic")!;
    expect(skeptic.activity).toBe("speaking");
    expect(skeptic.bubble).toBe("…");
  });

  it("terminal council at live cursor → all seats idle (wandering)", () => {
    const terminalDetail: CouncilDetailLike = { ...baseDetail, state: "done", speaking: null };
    const actors = deriveOfficeActors(terminalDetail, null, 2000);
    for (const actor of actors) {
      expect(actor.activity).toBe("idle");
    }
  });

  it("no speaker for >20s in live council → all idle", () => {
    const idleDetail: CouncilDetailLike = { ...baseDetail, speaking: null, speakingSince: 1000 };
    const actors = deriveOfficeActors(idleDetail, null, 25000);
    for (const actor of actors) {
      expect(actor.activity).toBe("idle");
    }
  });

  it("the owner is always on the floor, with no messages at all", () => {
    const emptyDetail: CouncilDetailLike = { ...baseDetail, speaking: null, speakingSince: null, messages: [] };
    const live = deriveOfficeActors(emptyDetail, null, 2000);
    expect(live.find((a) => a.id === OWNER_SEAT_ID)).toBeDefined();
    expect(live.find((a) => a.id === OWNER_SEAT_ID)!.activity).toBe("idle");

    const replay = deriveOfficeActors(baseDetail, 1, 2000);
    expect(replay.find((a) => a.id === OWNER_SEAT_ID)).toBeDefined();
  });

  it("the owner speaks only while his own message is the live message; otherwise he stays home", () => {
    const withOwnerThenSkeptic: CouncilDetailLike = {
      ...baseDetail,
      messages: [{ seq: 0, seatId: "owner", round: 0, kind: "owner", text: "What is our strategy?" }, ...baseDetail.messages],
    };
    const ownerSpeaking: CouncilDetailLike = { ...withOwnerThenSkeptic, speaking: "owner" };
    expect(deriveOfficeActors(ownerSpeaking, null, 2000).find((a) => a.id === OWNER_SEAT_ID)!.activity).toBe("speaking");
    // The skeptic speaks after the owner: the owner is not the speaker, so he is idle at home
    const ownerNotSpeaking = deriveOfficeActors(withOwnerThenSkeptic, null, 2000).find((a) => a.id === OWNER_SEAT_ID)!;
    expect(ownerNotSpeaking.activity).toBe("idle");
  });

  it("replay: the owner speaks only under the cursor on his own message", () => {
    const detail: CouncilDetailLike = {
      ...baseDetail,
      messages: [{ seq: 1, seatId: "owner", round: 0, kind: "owner", text: "What is our strategy?" }, ...baseDetail.messages.map((m) => ({ ...m, seq: m.seq + 1 }))],
    };
    expect(deriveOfficeActors(detail, 1, 2000).find((a) => a.id === OWNER_SEAT_ID)!.activity).toBe("speaking");
    expect(deriveOfficeActors(detail, 2, 2000).find((a) => a.id === OWNER_SEAT_ID)!.activity).toBe("idle");
  });

  it("replay: the owner holds at the table while a reply to him is within two messages", () => {
    const detail: CouncilDetailLike = {
      ...baseDetail,
      messages: [
        { seq: 1, seatId: "owner", round: 0, kind: "owner", text: "What is our strategy?" },
        { seq: 2, seatId: "product", round: 1, kind: "reply", text: "Focus on conversion." },
        { seq: 3, seatId: "chair", round: 1, kind: "agenda", text: "Next item." },
      ],
    };
    // Cursor on the next message: the reply to the owner is seq 2, so he still holds
    const afterOwner = deriveOfficeActors(detail, 2, 2000).find((a) => a.id === OWNER_SEAT_ID)!;
    expect(afterOwner.holdAtMeeting).toBe(true);
    // Cursor on a message with no owner link: no hold
    const unrelated = deriveOfficeActors({ ...detail, messages: [detail.messages[2]!] }, 3, 2000).find((a) => a.id === OWNER_SEAT_ID)!;
    expect(unrelated.holdAtMeeting).toBe(false);
  });

  it("replay cursor on an older message makes that message's author the speaker with that text", () => {
    const actors = deriveOfficeActors(baseDetail, 2, 2000);
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

  it("after replay pause (>20s), non-speakers become idle to wander and on resume switch back to waiting", () => {
    const pausedRecently = deriveOfficeActors(baseDetail, 2, 6000, { pausedSince: 1000 });
    expect(pausedRecently.find((a: OfficeActor) => a.id === "skeptic")!.activity).toBe("waiting");

    const pausedLong = deriveOfficeActors(baseDetail, 2, 26000, { pausedSince: 1000 });
    expect(pausedLong.find((a: OfficeActor) => a.id === "product")!.activity).toBe("speaking");
    expect(pausedLong.find((a: OfficeActor) => a.id === "skeptic")!.activity).toBe("idle");

    const resumed = deriveOfficeActors(baseDetail, 2, 27000, { pausedSince: null });
    expect(resumed.find((a: OfficeActor) => a.id === "skeptic")!.activity).toBe("waiting");
  });
});

describe("fitOfficeCamera", () => {
  it("contains the 44.4 × 22.7 floor with 3 % padding for every aspect", () => {
    const wide = fitOfficeCamera(1280 / 656);
    expect(wide.viewWidth).toBeGreaterThanOrEqual(44.4);
    expect(wide.viewHeight).toBeGreaterThanOrEqual(22.7);
    expect(wide.centerY).toBeCloseTo(1.3, 5);

    const tall = fitOfficeCamera(1024 / 900);
    expect(tall.viewHeight).toBeGreaterThan(wide.viewHeight);
    expect(tall.viewWidth / tall.viewHeight).toBeCloseTo(1024 / 900, 5);
  });
});

describe("resolveLabelCollisions", () => {
  it("collapses non-speakers that overlap by more than 30 %, never the speaker", () => {
    const crowded = [
      { id: "speaker", x: 100, y: 100, width: 60, height: 16, isSpeaker: true },
      { id: "listener1", x: 105, y: 105, width: 60, height: 16, isSpeaker: false },
      { id: "listener2", x: 110, y: 110, width: 60, height: 16, isSpeaker: false },
    ];

    const resolved = resolveLabelCollisions(crowded, { width: 400, height: 300 });
    expect(resolved).toHaveLength(3);

    const speaker = resolved.find((r) => r.id === "speaker")!;
    const l1 = resolved.find((r) => r.id === "listener1")!;
    const l2 = resolved.find((r) => r.id === "listener2")!;

    expect(speaker.collapsed).toBe(false);
    expect(l1.collapsed || l2.collapsed).toBe(true);
  });
});

describe("office agent simulation", () => {
  it("guarantees unique dedicated desks per agent", () => {
    const actorIds = ["chair", "owner", "product", "skeptic", "growth", "finance"];
    const agents = createOfficeAgents(actorIds);
    const deskIds = agents.filter((a) => a.id !== OWNER_SEAT_ID).map((a) => a.assignedDeskId);
    expect(new Set(deskIds).size).toBe(actorIds.length - 1);
    expect(agents.find((a) => a.id === OWNER_SEAT_ID)!.assignedDeskId).toBe("pt_director_chair");
  });

  it("enforces point reservation (one user per point) during simulation", () => {
    const actorIds = ["chair", "owner", "product", "skeptic", "growth", "finance"];
    const agents = createOfficeAgents(actorIds);
    const reservations = new Map<string, string>();
    const rng = makeRng(123);

    for (let sec = 0; sec < 300; sec += 10) {
      stepOfficeSimulation(agents, reservations, sec, 10, rng, false);
      const usedPoints = new Set<string>();
      for (const agent of agents) {
        expect(usedPoints.has(agent.currentPointId)).toBe(false);
        usedPoints.add(agent.currentPointId);
      }
    }
  });

  it("simulated hour satisfies time share invariants: >= 50% desk time, < 20% walking", () => {
    const actorIds = ["chair", "owner", "product", "skeptic", "growth", "finance"];
    const agents = createOfficeAgents(actorIds);
    const reservations = new Map<string, string>();
    const rng = makeRng(42);

    const TOTAL_SECONDS = 3600;
    const DT = 5;
    for (let sec = 0; sec < TOTAL_SECONDS; sec += DT) {
      stepOfficeSimulation(agents, reservations, sec, DT, rng, false);
    }

    for (const agent of agents) {
      const totalRecorded =
        agent.deskSeconds +
        agent.walkingSeconds +
        agent.sofaSeconds +
        agent.coffeeSeconds +
        agent.windowSeconds +
        agent.chatSeconds +
        agent.reportSeconds +
        agent.barSeconds;

      expect(totalRecorded).toBeCloseTo(TOTAL_SECONDS, 6);
      expect(agent.deskSeconds / TOTAL_SECONDS).toBeGreaterThanOrEqual(0.5);
      expect(agent.walkingSeconds / TOTAL_SECONDS).toBeLessThan(0.2);
    }
  });

  it("council duty override sends the seats to their meeting chairs; the owner stays home", () => {
    const actorIds = ["chair", "owner", "product", "skeptic"];
    const agents = createOfficeAgents(actorIds);
    const reservations = new Map<string, string>();

    stepOfficeSimulation(agents, reservations, 100, 10, () => 0.5, true);

    for (const agent of agents.filter((a) => a.id !== OWNER_SEAT_ID)) {
      expect(agent.activity).toBe("meeting");
      expect(agent.currentPointId).toBe(agent.assignedMeetingSeatId);
      expect(reservations.get(agent.currentPointId)).toBe(agent.id);
    }

    const owner = agents.find((a) => a.id === OWNER_SEAT_ID)!;
    expect(owner.currentPointId).not.toMatch(/^pt_(chair|owner|n|s)/);
    expect(owner.activity).not.toBe("meeting");
    expect(Object.keys(OWNER_SPOTS)).toContain(owner.currentPointId);
  });

  it("the owner stays in his spots during a long council and never walks to the table by simulation", () => {
    const agents = createOfficeAgents(["chair", "owner", "product", "skeptic"]);
    const reservations = new Map<string, string>();
    const rng = makeRng(7);

    for (let sec = 0; sec < 600; sec += 5) {
      stepOfficeSimulation(agents, reservations, sec, 5, rng, true);
      const owner = agents.find((a) => a.id === OWNER_SEAT_ID)!;
      expect(Object.keys(OWNER_SPOTS)).toContain(owner.currentPointId);
    }
  });

  it("no report visits happen during a live council", () => {
    const agents = createOfficeAgents(["chair", "owner", "product", "skeptic", "growth", "finance"]);
    const reservations = new Map<string, string>();
    const rng = makeRng(99);

    for (let sec = 0; sec < 900; sec += 5) {
      stepOfficeSimulation(agents, reservations, sec, 5, rng, true);
      for (const agent of agents) {
        expect(agent.activity).not.toBe("report");
      }
    }
  });

  it("report visits happen between council sessions, in the corridor, and never exceed two at once", () => {
    const agents = createOfficeAgents(["chair", "owner", "product", "skeptic", "growth", "finance", "design", "engineer"]);
    const reservations = new Map<string, string>();
    const rng = makeRng(2024);
    const reportPoints = new Set(["pt_director_report_1", "pt_director_report_2"]);
    let reportsSeen = 0;

    for (let sec = 0; sec < 3600; sec += 5) {
      stepOfficeSimulation(agents, reservations, sec, 5, rng, false);
      const reporting = agents.filter((a) => a.activity === "report");
      expect(reporting.length).toBeLessThanOrEqual(2);
      for (const agent of reporting) {
        expect(reportPoints.has(agent.currentPointId)).toBe(true);
        reportsSeen++;
      }
    }
    expect(reportsSeen).toBeGreaterThan(0);
  });

  it("returns every agent to its own desk after a break", () => {
    const agents: OfficeSimAgent[] = createOfficeAgents(["chair", "product"]);
    const reservations = new Map<string, string>();
    const rng = makeRng(5);
    for (let sec = 0; sec < 1200; sec += 5) {
      stepOfficeSimulation(agents, reservations, sec, 5, rng, false);
    }
    for (const agent of agents.filter((a) => a.id !== OWNER_SEAT_ID)) {
      expect(agent.currentPointId === agent.assignedDeskId || agent.activity !== "desk").toBe(true);
    }
  });
});
