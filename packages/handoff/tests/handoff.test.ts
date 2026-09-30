import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  buildCapabilityRegistry,
  canTransition,
  chooseRecipient,
  claimHandoffLease,
  createHandoff,
  expireOverdueHandoffs,
  extractHandoffReceiptBlock,
  getHandoff,
  handoffMessage,
  handoffMigrations,
  listHandoffEvents,
  listHandoffs,
  parseHandoffCard,
  parseHandoffReceipt,
  recordHandoffReceipt,
  releaseHandoffLease,
  transitionHandoff,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const sql of handoffMigrations) db.exec(sql);
  return db;
}

const draft = parseHandoffCard({
  fromAgent: "lane-pilot-pm",
  toAgent: "copy-lead",
  title: "Audience language for the checkout page",
  objective: "Collect how customers describe the checkout problem in their own words.",
  acceptance: ["A list of at least 20 phrases with sources", "Grouped by intent"],
  inputs: [{ kind: "path", ref: "materials/direct-queries.csv" }],
  budget: { maxMinutes: 30 },
});

describe("handoff contract", () => {
  it("accepts a fenced JSON card and applies defaults", () => {
    const parsed = parseHandoffCard("```json\n" + JSON.stringify({ fromAgent: "a", toAgent: "b", title: "t", objective: "o", acceptance: ["x"] }) + "\n```");
    expect(parsed.inputs).toEqual([]);
    expect(parsed.deadlineAt).toBeNull();
  });

  it("refuses a card without acceptance", () => {
    expect(() => parseHandoffCard({ fromAgent: "a", toAgent: "b", title: "t", objective: "o", acceptance: [] })).toThrow();
  });

  it("knows the legal transitions", () => {
    expect(canTransition("queued", "delivered")).toBe(true);
    expect(canTransition("queued", "done")).toBe(false);
    expect(canTransition("done", "in_progress")).toBe(false);
  });
});

describe("handoff store", () => {
  it("creates, delivers and completes a card with a receipt and an event trail", () => {
    const db = openDb();
    const created = createHandoff(db, { id: "h1", projectId: "p", runId: "r", ownerThreadId: "pm", draft, now: 1000 });
    expect(created.card.state).toBe("queued");

    const delivered = transitionHandoff(db, { id: "h1", to: "delivered", actor: "lane-pilot", recipientThreadId: "thr-copy", now: 2000 });
    expect(delivered.ok && delivered.handoff.card.recipientThreadId).toBe("thr-copy");

    const receipt = parseHandoffReceipt({ status: "done", summary: "24 phrases grouped into 4 intents", outputs: [".agents/copy/checkout-language.md"] });
    const done = recordHandoffReceipt(db, { id: "h1", receipt, actor: "copy-lead", now: 3000 });
    expect(done.ok && done.handoff.card.state).toBe("done");
    expect(getHandoff(db, "h1")?.receipt?.outputs).toEqual([".agents/copy/checkout-language.md"]);

    expect(listHandoffEvents(db, "h1").map((event) => event.to)).toEqual(["queued", "delivered", "accepted", "in_progress", "done"]);
  });

  it("refuses an illegal transition and reports the current state", () => {
    const db = openDb();
    createHandoff(db, { id: "h2", projectId: "p", draft });
    const result = transitionHandoff(db, { id: "h2", to: "done", actor: "x" });
    expect(result).toEqual({ ok: false, reason: "illegal_transition", from: "queued" });
  });

  it("gives one holder a lease at a time and frees it on a terminal state", () => {
    const db = openDb();
    createHandoff(db, { id: "h3", projectId: "p", draft });
    expect(claimHandoffLease(db, { id: "h3", holder: "a", leaseMs: 1000, now: 0 }).ok).toBe(true);
    expect(claimHandoffLease(db, { id: "h3", holder: "b", leaseMs: 1000, now: 500 })).toEqual({ ok: false, reason: "held_by_other", holder: "a" });
    expect(claimHandoffLease(db, { id: "h3", holder: "b", leaseMs: 1000, now: 1500 }).ok).toBe(true);
    expect(releaseHandoffLease(db, { id: "h3", holder: "a" })).toBe(false);
    expect(releaseHandoffLease(db, { id: "h3", holder: "b" })).toBe(true);
    transitionHandoff(db, { id: "h3", to: "canceled", actor: "pm" });
    expect(claimHandoffLease(db, { id: "h3", holder: "a", leaseMs: 10 })).toEqual({ ok: false, reason: "terminal" });
  });

  it("expires overdue cards and lists by state", () => {
    const db = openDb();
    createHandoff(db, { id: "late", projectId: "p", draft: { ...draft, deadlineAt: 100 }, now: 0 });
    createHandoff(db, { id: "fresh", projectId: "p", draft: { ...draft, deadlineAt: 10_000 }, now: 0 });
    expect(expireOverdueHandoffs(db, 200)).toEqual(["late"]);
    expect(listHandoffs(db, { projectId: "p", states: ["queued"] }).map((item) => item.card.id)).toEqual(["fresh"]);
  });
});

describe("capability registry", () => {
  const registry = buildCapabilityRegistry([
    { id: "copy-lead", displayName: "Copywriter", prompt: "---\nname: copy-lead\n---\nSite copywriter and audience lead. Personas, offers, headlines.", skills: ["site-copy-audience", "ru-text"] },
    { id: "seo-specialist", displayName: "SEO", prompt: "SEO PM: semantics, cocoons, Yandex Direct queries, audits.", skills: ["seo-tools"] },
    { id: "design-lead", displayName: "Designer", prompt: "Product and web designer: prototypes, mockups, UX audits." },
  ]);

  it("summarizes from the first prompt paragraph after front matter", () => {
    expect(registry[0]?.summary.startsWith("Site copywriter")).toBe(true);
  });

  it("prefers an explicit mention, then the best term match", () => {
    expect(chooseRecipient(registry, "@design-lead check the cabinet")?.agentId).toBe("design-lead");
    expect(chooseRecipient(registry, "cluster the Yandex Direct queries by intent")?.agentId).toBe("seo-specialist");
    expect(chooseRecipient(registry, "write headlines for the persona")?.agentId).toBe("copy-lead");
    expect(chooseRecipient(registry, "zzz")).toBeNull();
  });
});

describe("handoff messages", () => {
  it("renders the card and finds the receipt block in a reply", () => {
    const db = openDb();
    const stored = createHandoff(db, { id: "h9", projectId: "p", draft });
    const text = handoffMessage(stored.card);
    expect(text).toContain("Handoff h9 from lane-pilot-pm");
    expect(text).toContain("1. A list of at least 20 phrases");
    const reply = "Done.\n```json\n{\"handoff\":\"other\",\"status\":\"done\",\"summary\":\"x\"}\n```\n```json\n{\"handoff\":\"h9\",\"status\":\"blocked\",\"summary\":\"need the CSV\"}\n```";
    const block = extractHandoffReceiptBlock(reply, "h9");
    expect(block && parseHandoffReceipt(block).status).toBe("blocked");
    expect(extractHandoffReceiptBlock("no block", "h9")).toBeNull();
  });
});
