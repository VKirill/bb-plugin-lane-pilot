/** @vitest-environment jsdom */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { anamnesisHandler } from "../src/rooms/anamnesis/host";
import { createHub } from "../src/rooms/anamnesis/hub";
import { setLocaleOverride } from "@lane-pilot/i18n";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.setConfig({ testTimeout: 30_000 });

/** The tab against the real store (host handler, temp folder) through the real hub: what the owner does is what the store keeps. */
const previous = process.env.LANE_PILOT_ANAMNESIS_DIR;
let hub: ReturnType<typeof createHub>;
let kv: Map<string, unknown>;
let calls: Array<Record<string, unknown>>;
let reachable: boolean;
const T = Date.UTC(2026, 5, 1);
const ev = (ref: string, at = T) => [{ source: "git", ref, at }];

beforeEach(async () => {
  process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-ui-"));
  kv = new Map(); calls = []; reachable = true;
  hub = createHub({
    hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
    listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }],
    kv: { get: async <V,>(key: string) => kv.get(key) as V | undefined, set: async (key, value) => { kv.set(key, value); } },
  });
  await hub.ask({ op: "upsert", actor: "auto:git", reason: "t", records: [
    { kind: "skill", key: "lang:TypeScript", title: "TypeScript", statement: "many commits", attributes: { commits: 90, level: "applies", levels: [{ month: "2026-02", level: "familiar", commits: 5 }, { month: "2026-04", level: "applies", commits: 30 }] }, evidence: ev("a@1") },
    { kind: "project", key: "Lane Pilot", title: "Lane Pilot", statement: "Orchestrator", evidence: ev("a@2") },
    { kind: "preference", key: "reports", title: "Reports in Russian", statement: "short", evidence: ev("a@3") },
    { kind: "person", key: "Anna", title: "Anna the client", attributes: { relation: "client" }, evidence: ev("a@4") },
    { kind: "event", key: "release", title: "First release", firstSeen: Date.UTC(2026, 8, 20), lastSeen: Date.UTC(2026, 8, 20), evidence: ev("a@5", Date.UTC(2026, 8, 20)) },
  ] });
  installTestPluginRuntime();
});
afterEach(() => { cleanup(); setLocaleOverride(null); if (previous === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previous; });

/** The SDK's hooks exist once the test runtime is installed, so the tab is imported after it. */
async function mount() {
  installTestPluginRuntime();
  const { AnamnesisTab } = await import("../src/rooms/anamnesis/ui/anamnesis-tab");
  return renderSlot({ component: AnamnesisTab }, {}, { rpc: {
    anamnesis: async (input: unknown) => {
      const { request } = input as { request: Record<string, unknown> };
      calls.push(request);
      if (!reachable) throw new Error("No connected Mac mini found");
      if (request.op === "pass") return { result: { ran: true, messages: { total: 2, extract: { created: 1, merged: 0, contradictions: 0 } } } };
      return { result: await hub.dispatch(request as never) };
    },
  } as never });
}
const open = async (view: Awaited<ReturnType<typeof mount>>, id: string) => { await view.findByTestId("anm-counts"); fireEvent.click(view.getByTestId(`anm-view-${id}`)); };

describe("the Anamnesis tab", () => {
  it("says plainly when the store cannot be reached, and tries again", async () => {
    reachable = false;
    const view = await mount();
    await view.findByTestId("anm-error");
    expect(view.getByTestId("anm-error").textContent).toContain("No connected Mac mini");
    reachable = true;
    fireEvent.click(within(view.getByTestId("anm-error")).getByText("Try again"));
    await view.findByTestId("anm-counts");
    expect(view.queryByTestId("anm-error")).toBeNull();
  });

  it("opens on «who I am»: drafts marked, the sensitive record counted but not shown, the PM card empty until something is confirmed", async () => {
    const view = await mount();
    await waitFor(() => expect(view.getByTestId("anm-whoami").textContent).toContain("TypeScript"));
    const text = view.getByTestId("anm-whoami").textContent!;
    expect(text).toContain("[draft]");
    expect(text).not.toContain("Anna");
    expect(text).toContain("1 sensitive records");
    expect(view.getByTestId("anm-counts").textContent).toContain("5 records");
    expect(view.getByTestId("anm-sensitive-toggle").textContent).toContain("1 hidden");
    expect(view.getByTestId("anm-card").textContent).toContain("No confirmed facts yet");
  });

  it("hides sensitive records until asked, then shows them", async () => {
    const view = await mount();
    await open(view, "records");
    await waitFor(() => expect(view.getByTestId("anm-records").textContent).toContain("Lane Pilot"));
    expect(view.getByTestId("anm-records").textContent).not.toContain("Anna");
    fireEvent.click(within(view.getByTestId("anm-sensitive-toggle")).getByRole("switch"));
    await waitFor(() => expect(view.getByTestId("anm-records").textContent).toContain("Anna the client"));
    expect(view.getByTestId("anm-sens-person:anna").textContent).toBe("sensitive");
    // A sensitive record has no one-click «make public»; that takes the edit form and its hint.
    expect(view.queryByTestId("anm-public-person:anna")).toBeNull();
  });

  it("confirms a draft, marks a record public and back, and the PM card follows", async () => {
    const view = await mount();
    await open(view, "records");
    await view.findByTestId("anm-record-preference:reports");
    fireEvent.click(view.getByTestId("anm-confirm-preference:reports"));
    await waitFor(() => expect(view.getByTestId("anm-record-preference:reports").textContent).toContain("confirmed"));
    expect((await hub.ask({ op: "get", id: "preference:reports" })).record).toMatchObject({ status: "confirmed" });
    expect((await hub.ask({ op: "card" })).text).toContain("Preferences: short");
    fireEvent.click(view.getByTestId("anm-public-preference:reports"));
    await waitFor(() => expect(view.getByTestId("anm-sens-preference:reports").textContent).toBe("public"));
    expect((await hub.ask({ op: "history", id: "preference:reports" })).history[0]!.reason).toBe("marked public in the Anamnesis tab");
    fireEvent.click(view.getByTestId("anm-private-preference:reports"));
    await waitFor(() => expect(view.getByTestId("anm-sens-preference:reports").textContent).toBe("private"));
  });

  it("edits a record through the form, with the public hint, and keeps the history", async () => {
    const view = await mount();
    await open(view, "records");
    await view.findByTestId("anm-record-project:lane-pilot");
    fireEvent.click(view.getByTestId("anm-edit-project:lane-pilot"));
    const row = within(view.getByTestId("anm-record-project:lane-pilot"));
    fireEvent.change(row.getByLabelText("Statement"), { target: { value: "Orchestrator of coding agents" } });
    fireEvent.change(row.getByRole("combobox"), { target: { value: "public" } });
    expect(row.getByText(/Only you can set this/)).toBeTruthy();
    fireEvent.click(row.getByText("Save"));
    await waitFor(() => expect(view.getByTestId("anm-record-project:lane-pilot").textContent).toContain("Orchestrator of coding agents"));
    expect((await hub.ask({ op: "get", id: "project:lane-pilot" })).record).toMatchObject({ statement: "Orchestrator of coding agents", sensitivity: "public" });
    fireEvent.click(view.getByTestId("anm-more-project:lane-pilot"));
    await waitFor(() => expect(view.getByTestId("anm-detail-project:lane-pilot").textContent).toContain("edited in the Anamnesis tab"));
    expect(view.getByTestId("anm-detail-project:lane-pilot").textContent).toContain("git · a@2");
  });

  it("forgets only on the second click", async () => {
    const view = await mount();
    await open(view, "records");
    await view.findByTestId("anm-record-event:release");
    fireEvent.click(view.getByTestId("anm-forget-event:release"));
    expect(view.getByTestId("anm-forget-event:release").textContent).toBe("Sure? Forget");
    expect((await hub.ask({ op: "get", id: "event:release" })).record).not.toBeNull();
    fireEvent.click(view.getByTestId("anm-forget-event:release"));
    await waitFor(() => expect(view.queryByTestId("anm-record-event:release")).toBeNull());
    expect((await hub.ask({ op: "get", id: "event:release" })).record).toBeNull();
  });

  it("shows a contradiction next to what it contradicts and settles it either way", async () => {
    await hub.ask({ op: "edit", id: "preference:reports", patch: { status: "confirmed" }, reason: "owner" });
    await hub.ask({ op: "upsert", actor: "auto:jev-fragment", reason: "t", records: [{ kind: "preference", key: "msg-abc", title: "From now on reports in English", statement: "From now on all reports in English", status: "candidate",
      attributes: { contradicts: ["preference:reports"] }, evidence: [{ source: "bb-message", ref: "thr_1:1:0", at: T + 1000 }] }] });
    const view = await mount();
    await open(view, "review");
    const card = await view.findByTestId("anm-contradiction-preference:msg-abc");
    expect(card.textContent).toContain("Reports in Russian");
    expect(card.textContent).toContain("From now on all reports in English");
    fireEvent.click(view.getByTestId("anm-use-new-preference:msg-abc"));
    await waitFor(() => expect(view.queryByTestId("anm-contradiction-preference:msg-abc")).toBeNull());
    expect((await hub.ask({ op: "get", id: "preference:msg-abc" })).record).toMatchObject({ status: "confirmed" });
    expect((await hub.ask({ op: "get", id: "preference:reports" })).record).toMatchObject({ status: "rejected" });
  });

  it("keeping the old statement rejects the new one", async () => {
    await hub.ask({ op: "edit", id: "preference:reports", patch: { status: "confirmed" }, reason: "owner" });
    await hub.ask({ op: "upsert", actor: "auto:jev-fragment", reason: "t", records: [{ kind: "preference", key: "msg-abc", title: "English now", statement: "reports in English", status: "candidate",
      attributes: { contradicts: ["preference:reports"] }, evidence: [{ source: "bb-message", ref: "thr_1:1:0", at: T + 1000 }] }] });
    const view = await mount();
    await open(view, "review");
    fireEvent.click(await view.findByTestId("anm-keep-old-preference:msg-abc"));
    await waitFor(() => expect(view.queryByTestId("anm-contradiction-preference:msg-abc")).toBeNull());
    expect((await hub.ask({ op: "get", id: "preference:msg-abc" })).record).toMatchObject({ status: "rejected" });
    expect((await hub.ask({ op: "get", id: "preference:reports" })).record).toMatchObject({ status: "confirmed" });
  });

  it("draws the growth of a skill and its level", async () => {
    const view = await mount();
    await open(view, "skills");
    const skill = await view.findByTestId("anm-skill-skill:lang-typescript");
    expect(skill.textContent).toContain("applies");
    expect(skill.textContent).toContain("2026-02: familiar → 2026-04: applies");
    expect(within(skill).getByTestId("anm-level-chart").getAttribute("aria-label")).toBe("2026-02 familiar, 2026-04 applies");
  });

  it("lists events and projects by month", async () => {
    const view = await mount();
    await open(view, "timeline");
    const timeline = await view.findByTestId("anm-timeline");
    await waitFor(() => expect(timeline.textContent).toContain("2026-09"));
    expect(timeline.textContent).toContain("First release");
  });

  it("keeps Telegram and Elba off until switched on, takes the channels, and forgets a source on the second click", async () => {
    const view = await mount();
    await open(view, "sources");
    await view.findByTestId("anm-source-telegram");
    expect(view.getByTestId("anm-source-switch-telegram").getAttribute("aria-checked")).toBe("false");
    expect(view.getByTestId("anm-source-switch-elba").getAttribute("aria-checked")).toBe("false");
    expect(view.getByTestId("anm-source-git").textContent).toContain("Your git commits");
    fireEvent.change(view.getByTestId("anm-telegram-channels"), { target: { value: "@my_channel, @other_one" } });
    fireEvent.click(within(view.getByTestId("anm-source-telegram")).getByText("Save"));
    await waitFor(() => expect(calls.some((call) => call.op === "config" && call.set !== undefined)).toBe(true));
    expect(await hub.config()).toMatchObject({ telegramChannels: ["@my_channel", "@other_one"] });
    fireEvent.click(view.getByTestId("anm-source-switch-telegram"));
    await waitFor(() => expect(view.getByTestId("anm-source-switch-telegram").getAttribute("aria-checked")).toBe("true"));
    expect((await hub.ask({ op: "sources" })).sources.find((s) => s.source === "telegram")?.enabled).toBe(true);
    // Forgetting a source: the first click only arms the button.
    fireEvent.click(view.getByTestId("anm-source-forget-git"));
    expect((await hub.ask({ op: "get", id: "project:lane-pilot" })).record).not.toBeNull();
    fireEvent.click(view.getByTestId("anm-source-forget-git"));
    await waitFor(async () => expect((await hub.ask({ op: "get", id: "project:lane-pilot" })).record).toBeNull());
  });

  it("learning automatically is off by default; the switch turns it on and the daily pass can run", async () => {
    const view = await mount();
    await view.findByTestId("anm-auto");
    expect(view.getByTestId("anm-auto-switch").getAttribute("aria-checked")).toBe("false");
    expect((view.getByTestId("anm-run-pass") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByTestId("anm-auto-switch"));
    await waitFor(() => expect(view.getByTestId("anm-auto-switch").getAttribute("aria-checked")).toBe("true"));
    expect((await hub.config()).extract).toBe(true);
    fireEvent.click(view.getByTestId("anm-run-pass"));
    await waitFor(() => expect(view.getByTestId("anm-pass-report").textContent).toContain("2 new messages, 1 new records"));
  });

  it("lists the reports of the loads and passes kept on the machine", async () => {
    await hub.ask({ op: "load_report", mode: "daily", report: { ran: true, messages: { total: 4, extract: { created: 2, merged: 1, contradictions: 1 } }, hostSources: [{ source: "git" }] } });
    const view = await mount();
    await open(view, "reports");
    const report = await view.findByTestId("anm-reports");
    await waitFor(() => expect(report.textContent).toContain("daily pass"));
    expect(report.textContent).toContain("4 new messages, 2 new, 1 merged, 1 contradictions, 1 sources read");
  });

  it("speaks Russian when the locale is Russian, and the forget-all button asks twice", async () => {
    setLocaleOverride("ru");
    const view = await mount();
    await view.findByTestId("anm-counts");
    expect(view.getByTestId("anamnesis-tab").textContent).toContain("Анамнез");
    expect(view.getByTestId("anm-auto").textContent).toContain("Учиться автоматически");
    fireEvent.click(view.getByTestId("anm-forget-all"));
    expect(view.getByTestId("anm-forget-all").textContent).toBe("Точно? Забыть всё");
    expect((await hub.ask({ op: "status" })).counts.records).toBe(5);
    fireEvent.click(view.getByTestId("anm-forget-all"));
    await waitFor(async () => expect((await hub.ask({ op: "status" })).counts.records).toBe(0));
  });
});
