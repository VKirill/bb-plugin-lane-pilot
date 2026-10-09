import { describe, expect, it } from "vitest";
import {
  deriveOfficeActors,
  nextWanderTarget,
  seatColor,
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
