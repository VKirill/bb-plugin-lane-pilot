/** @vitest-environment jsdom */
// Region 7 · Providers, models, accounts, batch b: behaviour tests of the cards n626 .. n656 that had none (or none that a mutation of the node's own code fails).
// No real model, provider API or money: stand-in hosts, a scratch database, fixture events. Each test checks the result the card names.
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { breakerKey } from "@lane-pilot/resilience";
import { assertSafeArgv, buildCliInvocation } from "../../src/rooms/writer/argv-builder";
import { HELPER_ROLES, ROLE_PROFILES, effectiveGroup } from "../../src/rooms/contracts/helper-context";
import { PRESENCE_WINDOW_MS, laneOwnedMetadata, presenceHold } from "../../src/rooms/owner-presence/logic";
import { createOwnerPresence, observeOwnerDispatch } from "../../src/rooms/owner-presence/server";
import { walkWriterChain, waitingWriterText, writerHold, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { capOf, moneyHold, spendBook, type DailyRow } from "../../src/rooms/money/logic";
import { createMoney } from "../../src/rooms/money/server";
import { MoneyScreen } from "../../src/rooms/cockpit/ui/screens-day";
import { CAPABILITIES, adapterVersions, capabilityTable, dueProbes, receiptKey } from "../../src/rooms/capability/logic";
import { createCapabilities } from "../../src/rooms/capability/server";
import { listReceipts } from "../../src/rooms/capability";
import { progressJournal, toolPairsOf } from "../../src/rooms/writer/progress-journal";
import { compareDesigns, type Measurement } from "../../src/rooms/design-eval/logic";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";

afterEach(cleanup);

const MIN = 60_000;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const day = (offset: number) => new Date(T0 - offset * 86_400_000).toISOString().slice(0, 10);
const row = (providerId: string, inputTokens: number, onDay = day(0), outputTokens = 0): DailyRow => ({ day: onDay, providerId, model: "m", inputTokens, outputTokens, cachedTokens: 0 });

const holdDeps = (over: Partial<WriterHoldDeps> = {}) => ({ breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true, log: () => undefined, ...over }) as unknown as WriterHoldDeps;
const presenceOf = (marks: Array<{ providerId: string; at: number; hostId: string; host: string | null }>) => ({ current: () => marks, holds: (providerId: string, now?: number) => presenceHold(providerId, marks, now ?? T0) });

describe("model and worker choice (batch b)", () => {
  it("[sma:m_md_forbidden] an installer, an apply, a setup or a permission-bypass flag stops the launch before it starts, also with a value; any other flag goes through", () => {
    for (const token of ["--apply", "setup", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--yolo=1", "--apply=now", "setup=all"]) {
      expect(() => assertSafeArgv(["exec", "--model", "gpt-6-luna", token]), token).toThrow(`refusing argv token ${token}`);
    }
    expect(() => assertSafeArgv(["exec", "--model", "gpt-6-luna", "--sandbox", "read-only", "--yolo-not", "setups"])).not.toThrow();
    // The launch builder itself ends in the same check: a required flag that bypasses permissions never produces an argv.
    const build = (required: Record<string, string>) => buildCliInvocation({ binary: "run-controller", subcommand: "exec", settings: {}, required, validate: () => new Map() });
    expect(() => build({ "--dangerously-bypass-approvals-and-sandbox": "" })).toThrow(/refusing argv token --dangerously-bypass-approvals-and-sandbox/);
    expect(build({ "--json": "" }).argv).toEqual(["exec", "--json"]);
  });

  it("[sma:m_md_role] a named role loads its own profile; a role nobody listed is a specialist of the owner and starts with Env Catalog only; an owner's list replaces the role's", () => {
    expect(HELPER_ROLES).toEqual(Object.keys(ROLE_PROFILES));
    expect(HELPER_ROLES).toEqual(expect.arrayContaining(["pm-reader", "docs-maintainer", "browser-qa", "debugger"]));
    expect(effectiveGroup("docs-maintainer", "skills")).toEqual({ names: ["lp-docs", "docs-methodology"], source: "role" });
    expect(effectiveGroup("debugger", "mcpServers").names).toContain("gitnexus");
    expect(effectiveGroup("own-specialist" as never, "skills")).toEqual({ names: ["env-catalog"], source: "role" });
    expect(effectiveGroup("own-specialist" as never, "bbPlugins").names).toContain("env-catalog");
    expect(effectiveGroup("docs-maintainer", "skills", { skills: { mode: "allow", names: ["project-life"] } })).toEqual({ names: ["project-life"], source: "owner" });
    expect(effectiveGroup("docs-maintainer", "skills", { skills: { mode: "all" } })).toEqual({ names: null, source: "owner" });
  });

  it("[sma:m_md_day_owner] a provider the owner used in the last ten minutes is left alone, with the minutes and the machine named; a lane's own thread marks nothing", async () => {
    const mark = { providerId: "claude-code", at: T0 - 3 * MIN, hostId: "h1", host: "mac" };
    expect(presenceHold("claude-code", [mark], T0)).toBe("owner_present:claude-code used by the owner 3 min ago on mac");
    expect(presenceHold("claude-code", [{ ...mark, host: null }], T0)).toBe("owner_present:claude-code used by the owner 3 min ago on h1");
    expect(presenceHold("claude-code", [mark], mark.at + PRESENCE_WINDOW_MS)).not.toBeNull();
    expect(presenceHold("claude-code", [mark], mark.at + PRESENCE_WINDOW_MS + 1)).toBeNull();
    expect(presenceHold("codex", [mark], T0)).toBeNull();
    expect(laneOwnedMetadata({ role: "writer" })).toBe(true);
    expect(laneOwnedMetadata({ lanePilotRunId: "run_1" })).toBe(true);
    expect(laneOwnedMetadata({})).toBe(false);
    expect(laneOwnedMetadata(null)).toBe(false);
    // The owner's message in a thread of his own marks its provider; the same message in a lane thread does not.
    const kv = new Map<string, string>();
    const bb = { log: { warn() {} }, storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: string) => { kv.set(key, value); } } },
      sdk: { threads: { getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === "thr_lane" ? { role: "errand" } : {}) } } };
    const presence = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    const sent = (threadId: string, providerId: string) => observeOwnerDispatch(bb as never, { initiator: "user", senderThreadId: null, thread: { id: threadId }, requestedExecution: { providerId }, host: { id: "h_mini", name: "mini" } });
    await sent("thr_owner", "codex");
    await sent("thr_lane", "opencode2");
    expect(presence.holds("codex")).toMatch(/^owner_present:codex used by the owner 0 min ago on mini$/);
    expect(presence.holds("opencode2")).toBeNull();
  });

  it("[sma:m_md_busy] the writer chain passes by the member whose provider the owner is working in and gives the task to the next one; once the ten minutes are over the first member is free again", async () => {
    const chain = [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt-6-luna" }];
    const marks = [{ providerId: "claude-code", at: T0 - 2 * MIN, hostId: "h1", host: "mac" }];
    const busy = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ presence: presenceOf(marks) }), T0);
    expect(busy.free?.member.providerId).toBe("codex");
    expect(busy.free?.index).toBe(1);
    expect(busy.holds).toHaveLength(1);
    expect(busy.holds[0]!.hold.reason).toBe("writer_provider_unavailable:owner_present:claude-code used by the owner 2 min ago on mac");
    // The hold says when to ask again: the mark plus the ten-minute window.
    expect(busy.holds[0]!.hold.until).toBe(marks[0]!.at + PRESENCE_WINDOW_MS);
    const later = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ presence: presenceOf(marks) }), marks[0]!.at + PRESENCE_WINDOW_MS + 1);
    expect(later.free?.member.providerId).toBe("claude-code");
    expect(later.holds).toEqual([]);
    // Only member of the chain busy: nothing is free and the board line says whose work it waits for.
    const only = await walkWriterChain([chain[0]!], { hostId: "h1", settings: {} }, holdDeps({ presence: presenceOf(marks) }), T0);
    expect(only.free).toBeUndefined();
    expect(waitingWriterText(only.shortest!.hold, only.wakeAt, T0)).toBe("Ждёт писателя: владелец работает в Claude Code, проверка через 8 мин");
  });

  it("[sma:m_md_window_wait] with every member held the task waits for the earliest of them and is never failed; a paid member free under its cap takes it instead, a capped one waits for the first of next month", async () => {
    const chain = [{ providerId: "codex", model: "gpt-6-luna" }, { providerId: "claude-code", model: "sonnet" }];
    const breaker = { snapshot: () => [{ key: breakerKey("codex", "gpt-6-luna"), state: "open", openedAt: T0 - MIN, failures: 3 }] };
    const presence = presenceOf([{ providerId: "claude-code", at: T0 - 3 * MIN, hostId: "h1", host: "mac" }]);
    const walk = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ breaker, presence } as never), T0);
    expect(walk.free).toBeUndefined();
    expect(walk.allUnsupported).toBe(false);
    // The breaker frees at openedAt + 5 minutes (T0 + 4 min), the owner's mark at +10 minutes (T0 + 7 min): the earlier one decides.
    expect(walk.wakeAt).toBe(T0 + 4 * MIN);
    expect(walk.shortest?.member.providerId).toBe("codex");
    expect(waitingWriterText(walk.shortest!.hold, walk.wakeAt, T0)).toBe("Ждёт писателя: провайдер Codex временно недоступен после сбоев, проверка через 4 мин");
    // The subscription windows are closed on the one member; the paid lane after it runs while its cap lets it.
    const paid = [{ providerId: "claude-code", model: "sonnet" }, { providerId: "openlux", model: "gpt-5-codex" }];
    const closed = { hold: async ({ providerId }: { providerId: string }) => (providerId === "claude-code" ? { percent: 99, window: "five_hour", resetsAt: new Date(T0 + 30 * MIN).toISOString() } : null) } as WriterHoldDeps["usage"];
    const money = (answer: string | null) => ({ capHolds: async () => answer });
    const allowed = await walkWriterChain(paid, { hostId: "h1", settings: {} }, holdDeps({ usage: closed, money: money(null) }), T0);
    expect(allowed.free?.member.providerId).toBe("openlux");
    const capped = await walkWriterChain(paid, { hostId: "h1", settings: {} }, holdDeps({ usage: closed, money: money("money cap: spent") }), T0);
    expect(capped.free).toBeUndefined();
    const cappedHold = capped.holds.find((held) => held.member.providerId === "openlux")!.hold;
    expect(cappedHold.reason).toBe("writer_provider_unavailable:money_cap:money cap: spent");
    expect(cappedHold.until).toBe(Date.UTC(2026, 11, 1));
  });

  it("[sma:m_md_agent_model] a member whose provider window is almost spent is passed by and the next model of the chain takes the task; with every window spent the writer's own pair is tried, not parked", async () => {
    const chain = [{ providerId: "claude-code", model: "claude-opus-5-5" }, { providerId: "codex", model: "gpt-6.1-sol" }];
    const resetsAt = new Date(T0 + 90 * MIN).toISOString();
    const spent = (providers: string[]) => ({ hold: async ({ providerId }: { providerId: string }) => (providers.includes(providerId) ? { percent: 97, window: "five_hour", resetsAt } : null) }) as WriterHoldDeps["usage"];
    const walk = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ usage: spent(["claude-code"]) }), T0);
    expect(walk.free?.member).toEqual({ providerId: "codex", model: "gpt-6.1-sol" });
    expect(walk.free?.index).toBe(1);
    const hold = await writerHold({ providerId: "claude-code", model: "claude-opus-5-5", hostId: "h1", settings: {} }, holdDeps({ usage: spent(["claude-code"]) }), T0);
    expect(hold?.reason).toMatch(/usage_window:claude-code/);
    expect(hold?.until).toBe(Date.parse(resetsAt));
    expect(await writerHold({ providerId: "codex", model: "gpt-6.1-sol", hostId: "h1", settings: {} }, holdDeps({ usage: spent(["claude-code"]) }), T0)).toBeNull();
    const all = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ usage: spent(["claude-code", "codex"]) }), T0);
    expect(all.free?.member.providerId).toBe("claude-code");
    expect(all.free?.index).toBe(0);
  });
});

/** A hub database with the global money settings and, if asked, openlux spend today (openlux is 0.5 USD per million input tokens). */
function moneyWorld(settings: Record<string, unknown>, spentUsd = 0, projectSettings: Array<[string, string, unknown]> = []) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "*", key, value);
  for (const [project, key, value] of projectSettings) saveProjectSetting(db, project, key, value);
  if (spentUsd) db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,input_tokens,output_tokens,cached_tokens,total_tokens) VALUES (?,?,?,?,?,0,0,?)")
    .run(new Date().toISOString().slice(0, 10), "proj", "openlux", "m", spentUsd * 2_000_000, spentUsd * 2_000_000);
  return createMoney({ db: db as never, bb: { hosts: { experimental_client: () => ({ call: async () => ({ windows: {} }) }) } } as never }).money;
}

describe("money and spend (batch b)", () => {
  it("[sma:m_mo_bind] the writer chain asks the hub's money for the cap, the spend book and the accounts: a paid member holds on what the hub spent, a subscription member never asks", async () => {
    const money = moneyWorld({ "money.monthly_cap_usd": 10 }, 11);
    expect(await money.holds("openlux", "gpt-5-codex", "h1")).toMatch(/^money cap: 11\.00 of 10\.00 USD spent this month on paid lanes/);
    expect(await money.capHolds("openlux", "gpt-5-codex", "h1")).toMatch(/^money cap: 11\.00 of 10\.00 USD/);
    expect(await money.holds("claude-code", "sonnet", "h1")).toBeNull();
    const chain = [{ providerId: "openlux", model: "gpt-5-codex" }, { providerId: "claude-code", model: "sonnet" }];
    const walk = await walkWriterChain(chain, { hostId: "h1", settings: {} }, holdDeps({ money }), T0);
    expect(walk.holds.map((held) => [held.member.providerId, held.hold.reason.startsWith("writer_provider_unavailable:money_cap:money cap: 11.00 of 10.00 USD")])).toEqual([["openlux", true]]);
    expect(walk.free?.member.providerId).toBe("claude-code");
    // Under the cap the same hub holds nothing; with no cap set a paid lane is closed by name.
    expect(await moneyWorld({ "money.monthly_cap_usd": 10 }, 3).holds("openlux", "gpt-5-codex", "h1")).toBeNull();
    expect(await moneyWorld({}, 0).holds("openlux", "gpt-5-codex", "h1")).toMatch(/^no money cap is set: openlux is a paid lane/);
  });

  it("[sma:m_mo_cap_read] the stop and the spend screen read the cap from the one global row: a string number, a project's own row ignored, the word unlimited reads as no cap on purpose", async () => {
    const money = moneyWorld({ "money.monthly_cap_usd": "12.5" }, 2, [["proj", "money.monthly_cap_usd", 99]]);
    expect(money.status()).toMatchObject({ cap: 12.5, capSet: true, unlimited: false, monthUsd: 2, left: 10.5 });
    expect(await money.holds("openlux", "m", "h1")).toBeNull();
    const spent = moneyWorld({ "money.monthly_cap_usd": "12.5" }, 13);
    expect(spent.status()).toMatchObject({ cap: 12.5, monthUsd: 13, left: 0 });
    expect(await spent.holds("openlux", "m", "h1")).toMatch(/13\.00 of 12\.50 USD/);
    const unlimited = moneyWorld({ "money.monthly_cap_usd": "unlimited" }, 500);
    expect(unlimited.status()).toMatchObject({ cap: null, capSet: false, unlimited: true });
    expect(await unlimited.holds("openlux", "m", "h1")).toBeNull();
    expect(moneyWorld({}).status()).toMatchObject({ cap: null, capSet: false, unlimited: false });
  });

  it("[sma:m_mo_cap_fn] the cap setting becomes a number in one place: a dollar amount stays itself (no cents, no currency), a text number is read, zero, a negative and a non-number are not a cap", () => {
    expect(capOf(10)).toBe(10);
    expect(capOf(250)).toBe(250);
    expect(capOf("12.5")).toBe(12.5);
    expect(capOf("unlimited")).toBe(Infinity);
    expect(capOf(0)).toBeNull();
    expect(capOf("0")).toBeNull();
    expect(capOf(-5)).toBeNull();
    expect(capOf("-3")).toBeNull();
    expect(capOf("abc")).toBeNull();
    expect(capOf(Number.NaN)).toBeNull();
    expect(capOf(undefined)).toBeNull();
    expect(capOf(null)).toBeNull();
  });

  it("[sma:m_mo_set] the cap dialog writes only money.monthly_cap_usd to the hub-wide scope as the number typed, or the word unlimited, retries once on a version conflict and re-reads the status", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const answers: unknown[] = [{ ok: false, conflict: true, version: 3 }, { ok: true }, { ok: true }];
    const rpc = { call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "money_status") return { monthUsd: 1, cap: null, left: null, table: [] };
      if (method === "save_setting") return answers.shift();
      return { at: null, windows: {} };
    } };
    const view = render(createElement(MoneyScreen, { rpc: rpc as never, hostId: null }));
    const dialog = await waitFor(() => view.getByTestId("ck-money-cap"));
    const input = dialog.querySelector("input")!;
    const button = dialog.querySelector("button")!;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter((call) => call.method === "save_setting")).toHaveLength(2));
    const saves = calls.filter((call) => call.method === "save_setting").map((call) => call.args);
    expect(saves).toEqual([
      { projectId: "*", key: "money.monthly_cap_usd", value: 50, expectedVersion: 0 },
      { projectId: "*", key: "money.monthly_cap_usd", value: 50, expectedVersion: 3 },
    ]);
    // The screen re-reads the money status after the save.
    await waitFor(() => expect(calls.filter((call) => call.method === "money_status").length).toBeGreaterThanOrEqual(2));
    fireEvent.change(input, { target: { value: "unlimited" } });
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter((call) => call.method === "save_setting")).toHaveLength(3));
    expect(calls.filter((call) => call.method === "save_setting")[2]!.args).toEqual({ projectId: "*", key: "money.monthly_cap_usd", value: "unlimited", expectedVersion: 0 });
  });

  it("[sma:m_mo_stop] a paid lane stops at exactly the cap — spent equal to the cap is spent — and not a cent before; a subscription lane never stops for money", () => {
    expect(moneyHold("openlux", 10, 10)).toBe("money cap: 10.00 of 10.00 USD spent this month on paid lanes; openlux waits for the next month or a higher money.monthly_cap_usd, subscription lanes go on");
    expect(moneyHold("openlux", 9.99, 10)).toBeNull();
    expect(moneyHold("anthropic", 11, 10)).toMatch(/^money cap: 11\.00 of 10\.00 USD/);
    expect(moneyHold("codex", 1_000, 10)).toBeNull();
    expect(moneyHold("openlux", 1_000, Infinity)).toBeNull();
  });

  it("[sma:m_mo_month] the month to date counts this month's days at the lane's price, leaves last month and the subscription lanes out, and rounds to cents", () => {
    // NOW is 10 November: the 29th of October is inside the 14-day series but not inside the month.
    const book = spendBook([row("openlux", 2_000_000), row("anthropic", 1_000_000, day(2)), row("openlux", 4_000_000, day(12)), row("claude-code", 9_000_000, day(1))], T0);
    expect(book.monthUsd).toBe(4);
    expect(book.byProvider).toEqual({ openlux: 1, anthropic: 3, "claude-code": 0 });
    expect(book.series.find((entry) => entry.day === day(12))?.usd).toBe(2);
    expect(spendBook([row("openai", 1_234_567)], T0).monthUsd).toBe(3.09);
    expect(spendBook([], T0).monthUsd).toBe(0);
  });

  it("[sma:m_mo_accounts] the stop and the screen cannot disagree: one account's spend over several days is summed in the same book, and the hub's status carries the very number the hold quotes", async () => {
    const book = spendBook([row("openlux", 2_000_000, day(0)), row("openlux", 2_000_000, day(3)), row("openai", 400_000, day(1))], T0);
    expect(book.byProvider).toEqual({ openlux: 2, openai: 1 });
    expect(book.monthUsd).toBe(3);
    const money = moneyWorld({ "money.monthly_cap_usd": 10 }, 11);
    const status = money.status();
    expect(status.byProvider).toEqual({ openlux: 11 });
    expect(status.monthUsd).toBe(11);
    expect(await money.holds("openlux", "m", "h1")).toContain(`${status.monthUsd.toFixed(2)} of 10.00 USD`);
  });

  it("[sma:m_mo_series] the spend series is the last 14 days, oldest first and ending today, a row older than that is not in it, and a day names only the paid accounts that spent on it", () => {
    const book = spendBook([row("openlux", 2_000_000, day(0)), row("openlux", 2_000_000, day(13)), row("openlux", 2_000_000, day(14)), row("codex", 5_000_000, day(5))], T0);
    expect(book.series).toHaveLength(14);
    expect(book.series[0]!.day).toBe(day(13));
    expect(book.series[13]!.day).toBe(day(0));
    expect(book.series[13]).toEqual({ day: day(0), usd: 1, byProvider: { openlux: 1 } });
    expect(book.series[0]).toEqual({ day: day(13), usd: 1, byProvider: { openlux: 1 } });
    expect(book.series.reduce((sum, entry) => sum + entry.usd, 0)).toBe(2);
    expect(book.series.find((entry) => entry.day === day(5))).toEqual({ day: day(5), usd: 0, byProvider: {} });
  });
});

describe("provider probes (batch b)", () => {
  const SANDBOX = "proj_3tb652jpsi";
  function sweepWorld() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }, { id: "claude-code", pluginId: "provider-claude-code" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    const db = openDatabase(bb);
    createRun(db, "run_s", SANDBOX, "bb", "/s");
    setRunThread(db, "run_s", "thr_pm");
    const probes: Array<unknown[]> = [];
    const services = { startHelperProbe: async (...args: unknown[]) => { probes.push(args); return { ok: true, reason: null }; }, providerBreaker: { record: () => undefined } };
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, services as never).capabilities;
    return { api, db, probes };
  }

  it("[sma:m_pr_create] the sweep probes each provider in use that has an installed adapter, on the sandbox project's run, with the provider's own model, once per receipt key", async () => {
    const { api, db, probes } = sweepWorld();
    const first = await api.sweep();
    // Only codex has an adapter version (its plugin is listed); claude-code has none and is not probed.
    expect(probes.map((args) => args.slice(0, 4))).toEqual(CAPABILITIES.map(() => [SANDBOX, "run_s", "codex", "gpt-6-luna"]));
    expect(probes.map((args) => args[4])).toEqual([...CAPABILITIES]);
    expect(first.map((entry) => entry.state)).toEqual(CAPABILITIES.map((capability) => `${capability}:supported`));
    expect(listReceipts(db).map((receipt) => [receipt.providerId, receipt.model, receipt.state])).toEqual(CAPABILITIES.map(() => ["codex", "gpt-6-luna", "supported"]));
    probes.length = 0;
    expect(await api.sweep()).toEqual([]);
    expect(probes).toEqual([]);
  });

  it("[sma:m_pr_version] the adapter version is the version of the plugin that provides the provider, null when it is not listed; a new version or a changed model voids the receipt and the provider is due again", () => {
    const versions = adapterVersions([{ id: "codex", pluginId: "provider-codex" }, { id: "opencode2", pluginId: "gone" }, { id: "x" }], [{ id: "provider-codex", version: "0.1.0" }, { id: "other", version: "9" }]);
    expect([...versions]).toEqual([["codex", "0.1.0"], ["opencode2", null], ["x", null]]);
    const hooks = "hooks-v1";
    const key = (version: string, model: string) => receiptKey({ version, model, hooks });
    expect(key("0.1.0", "gpt-6-luna")).toBe(key("0.1.0", "gpt-6-luna"));
    expect(key("0.1.0", "gpt-6-luna")).toMatch(/^0\.1\.0#[0-9a-f]{16}$/);
    expect(key("0.1.1", "gpt-6-luna")).not.toBe(key("0.1.0", "gpt-6-luna"));
    expect(key("0.1.0", "gpt-6-sol")).not.toBe(key("0.1.0", "gpt-6-luna"));
    expect(receiptKey({ version: "0.1.0", model: "gpt-6-luna", hooks: "hooks-v2" })).not.toBe(key("0.1.0", "gpt-6-luna"));
    const inUse = new Map([["codex", "gpt-6-luna"]]);
    const receipts = CAPABILITIES.map((capability) => ({ providerId: "codex", version: key("0.1.0", "gpt-6-luna"), capability, state: "supported" as const, model: "gpt-6-luna", detail: null, at: 1 }));
    expect(dueProbes(inUse, new Map([["codex", key("0.1.0", "gpt-6-luna")]]), receipts)).toEqual([]);
    expect(dueProbes(inUse, new Map([["codex", key("0.1.1", "gpt-6-luna")]]), receipts)).toEqual([{ providerId: "codex", model: "gpt-6-luna", version: key("0.1.1", "gpt-6-luna") }]);
    expect(capabilityTable(inUse, new Map([["codex", key("0.1.1", "gpt-6-luna")]]), receipts)[0]!.capabilities.answers).toBe("unproven");
  });

  it("[sma:m_pr_codex_progress] the commands and tool calls a Codex thread streams become the progress journal's lines: a command with its output, a tool call by its name, the model's own words left out, a long line cut with a mark", () => {
    const events = [
      { data: { item: { type: "userMessage", text: "go" } } },
      { data: { item: { type: "commandExecution", command: "npm test", aggregatedOutput: "ok 3 tests" } } },
      { data: { item: { type: "agentMessage", text: "I ran npm test" } } },
      { data: { item: { type: "toolCall", name: "read_file", input: { path: "a.ts" }, output: "export {}" } } },
      { data: { item: { type: "commandExecution", command: `echo ${"x".repeat(500)}`, aggregatedOutput: "y".repeat(500) } } },
      { type: "turn/started" },
    ];
    const pairs = toolPairsOf(events);
    expect(pairs.map((pair) => [pair.tool, pair.call.slice(0, 20), pair.result])).toEqual([["commandExecution", "npm test", "ok 3 tests"], ["read_file", "read_file", "export {}"], ["commandExecution", `echo ${"x".repeat(15)}`, "y".repeat(500)]]);
    const journal = progressJournal({ attemptId: "a1", taskId: "T1", produced: ["src/a.ts"], events });
    expect(journal).toContain("- src/a.ts");
    expect(journal).toContain("- commandExecution: npm test\n  ok 3 tests");
    expect(journal).toContain("- read_file: read_file\n  export {}");
    expect(journal).toMatch(/\[cut: \d+ chars\]/);
    expect(journal).not.toContain("I ran npm test");
  });

  it("[sma:m_pr_design_eval] two versions of a page go to the code judge by its rubric: the cleaner one wins, the changes name the criterion and the width, equal pages tie", () => {
    const clean: Measurement = { width: 390, overflowPx: 0, textElements: 10, lowContrast: 0, targets: 5, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 8 };
    const bad: Measurement = { ...clean, overflowPx: 40, lowContrast: 4, h1: 0 };
    const forward = compareDesigns([clean], [bad]);
    expect(forward.winner).toBe("a");
    expect(forward.a).toBe(100);
    expect(forward.b).toBeLessThan(forward.a);
    expect(forward.changes).toEqual([{ width: 390, id: "overflow", a: 1, b: 0 }, { width: 390, id: "contrast", a: 1, b: 0 }, { width: 390, id: "one_h1", a: 1, b: 0 }]);
    const backward = compareDesigns([bad], [clean]);
    expect(backward.winner).toBe("b");
    expect([backward.a, backward.b]).toEqual([forward.b, forward.a]);
    expect(compareDesigns([clean], [{ ...clean }])).toEqual({ winner: "tie", a: 100, b: 100, changes: [] });
  });
});
