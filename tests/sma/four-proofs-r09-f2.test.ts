// Region 9 · Person and window, batch f, second half: the pure parts — the browser bell's notice (n925), the command palette (n926) and the screen a path opens (n930).
// What was produced is also written down with observe(): the region scene sma_r09 compares those values with the cards.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { SCREENS, screenFor, searchCockpit } from "../../src/rooms/cockpit/ui/registry";
import { ackDigest, planBellNotice, savePushConfig } from "../../src/rooms/owner-waiting/push";
import { postOwnerItem } from "../../src/rooms/owner-waiting/items";
import { openDatabase } from "../../src/rooms/plugin-db";
import { observe } from "./r09-world-f";

const item = (key: string) => ({ key, source: "inbox", kind: "decision", what: "w", why: "y", actions: [{ id: "a", label: "a", cli: "bb lane-pilot waiting" }] }) as never;

describe("region 9 · the bell", () => {
  it("[sma:m_ws_notify] the bell says one thing — how many wait for a decision — with no item text, once per item, and says it again only for a new item", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" } as never);
    const db = openDatabase(bb);
    savePushConfig(db, { quiet: "00:00-00:00" });
    const seeded = planBellNotice(db, Date.now(), []);
    expect(seeded).toEqual({ send: false, reason: "nothing_new", title: "", text: "", keys: [] });
    postOwnerItem(db, item("k1"));
    postOwnerItem(db, item("k2"));
    const notice = planBellNotice(db, Date.now(), []);
    expect({ ...notice, keys: [...notice.keys].sort() }).toEqual({ send: true, reason: null, title: "Lane Pilot: ждёт решения — 2", text: "2 — на экране «Ждут владельца».", keys: ["bell:k1", "bell:k2"] });
    ackDigest(db, notice.keys);
    expect(planBellNotice(db, Date.now(), [])).toEqual({ send: false, reason: "nothing_new", title: "", text: "", keys: [] });
    postOwnerItem(db, item("k3"));
    const next = planBellNotice(db, Date.now(), []);
    expect({ title: next.title, keys: next.keys }).toEqual({ title: "Lane Pilot: ждёт решения — 1", keys: ["bell:k3"] });
    observe("n925", { first: { title: notice.title, text: notice.text, keys: [...notice.keys].sort() }, again: { send: false, reason: "nothing_new" }, next: { title: next.title, keys: next.keys } });
  });
});

describe("region 9 · the command palette", () => {
  it("[sma:m_ws_palette] one field finds a screen by its name, its id or the events that open it, then the project's phases, then its tasks, each hit saying what it is; nothing found is an empty list and an empty field lists every screen in the registry's order", () => {
    setLocaleOverride("en");
    const extra = { phases: [{ id: "ph1", title: "Cart phase" }, { id: "ph2", title: "Footer" }], tasks: [{ id: "t-9", title: "Cart total" }, { id: "t-10", title: "Login" }] };
    const cart = searchCockpit("cart", extra);
    expect(cart).toEqual([{ kind: "phase", id: "ph1", title: "Cart phase" }, { kind: "task", id: "t-9", title: "Cart total" }]);
    const byEvent = searchCockpit("uat", extra).map((hit) => `${hit.kind}:${hit.id}`);
    expect(byEvent).toEqual(["screen:phases"]);
    const byName = searchCockpit(t("ckScreen_money").toUpperCase(), extra).map((hit) => `${hit.kind}:${hit.id}`);
    expect(byName).toEqual(["screen:money"]);
    expect(searchCockpit("phases", extra).map((hit) => `${hit.kind}:${hit.id}`)).toEqual(["screen:phases"]);
    expect(searchCockpit("t-1", extra).map((hit) => `${hit.kind}:${hit.id}`)).toEqual(["task:t-10"]);
    const mixed = searchCockpit("o", extra).map((hit) => hit.kind);
    expect(mixed).toEqual([...mixed].sort((a, b) => ["screen", "phase", "task"].indexOf(a) - ["screen", "phase", "task"].indexOf(b)));
    expect(searchCockpit("zzzz-nothing", extra)).toEqual([]);
    expect(searchCockpit("   ", extra).map((hit) => hit.id)).toEqual(SCREENS.map((row) => row.id));
    observe("n926", { cart: cart.map((hit) => `${hit.kind}:${hit.id}`), byEvent, byName, nothing: searchCockpit("zzzz-nothing", extra).length, all: searchCockpit("").length });
  });
});

describe("region 9 · opening a screen by an event", () => {
  it("[sma:m_ws_navigation] an event path opens the screen that event belongs to (every event of the registry, none to two screens), a plain path its screen with what follows it as the thing to open, no path the home, and an event nobody listens to the placeholder", () => {
    expect(screenFor("")).toEqual({ id: "home", param: null });
    expect(screenFor("/")).toEqual({ id: "home", param: null });
    expect(screenFor("phases")).toEqual({ id: "phases", param: null });
    expect(screenFor("/phases/ph_7")).toEqual({ id: "phases", param: "ph_7" });
    expect(screenFor("event/uat")).toEqual({ id: "phases", param: null });
    expect(screenFor("event/queue")).toEqual({ id: "tasks", param: null });
    expect(screenFor("event/worker")).toEqual({ id: "workers", param: null });
    expect(screenFor("event/nobody")).toEqual({ id: "building", param: "nobody" });
    expect(screenFor("event")).toEqual({ id: "building", param: null });
    expect(screenFor("nonsense/x")).toEqual({ id: "building", param: "nonsense" });
    const every: Record<string, string> = {};
    for (const row of SCREENS) for (const event of row.events) every[event] = screenFor(`event/${event}`).id;
    expect(Object.keys(every)).toHaveLength(SCREENS.reduce((sum, row) => sum + row.events.length, 0));
    for (const row of SCREENS) for (const event of row.events) expect(every[event]).toBe(row.id);
    observe("n930", { uat: screenFor("event/uat"), nobody: screenFor("event/nobody"), plain: screenFor("/phases/ph_7"), home: screenFor(""), events: Object.keys(every).length });
  });
});
