// Probe of scenes/sma_r10.py (region 10, the Telegram bridge; also n818 of region 9): runs the REAL code of the Telegram plugin
// (bb-plugin-telegram-projects, the sibling worktree SMA_SIBLING_TELEGRAM or the proofs worktree) on the SDK's fake plugin host against a
// STAND-IN Bot API (a fake fetch; no request leaves the machine, no real Telegram, no hub, no model, no real BB CLI) and prints what it saw as
// one JSON line. It judges nothing: the scene compares every value with the node card and prove()s it.
// What this cannot show: that the real Telegram accepts the requests, and anything that needs the plugin enabled on the hub.
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSibling } from "../../../src/rooms/sma-map/siblings";

const found = resolveSibling("telegram");
if (found.root === null) {
  process.stdout.write(`${JSON.stringify({ absent: found.why })}\n`);
  process.exit(0);
}
const root = found.root;
const sup = await import(`${root}/test/sma-support.ts`);
const bridgeSup = await import(`${root}/test/sma-bridge-support.ts`);
const { telegram } = await import(`${root}/adapters.ts`);
const { routeUpdate } = await import(`${root}/ingress.ts`);
const { pluginHost, fakeTelegram, fastTimers, runUntilDrained, update, OWNER, TOKEN } = sup;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(5);
  return check();
}
async function world<T>(body: (tg: ReturnType<typeof fakeTelegram>, timers: ReturnType<typeof fastTimers>) => Promise<T>): Promise<T> {
  const tg = fakeTelegram();
  const timers = fastTimers();
  try {
    return await body(tg, timers);
  } finally {
    tg.restore();
    timers.restore();
  }
}
async function withClock<T>(offset: number, body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + offset;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}
const paired = async (settings = {}) => {
  const host = await pluginHost(settings);
  host.store.put("owner:id", OWNER);
  return host;
};
const out: Record<string, unknown> = {};

// Door and link: n818, n975-n978, n980-n982.
out.link = await world(async (tg) => {
  tg.answers.getWebhookInfo = () => ({ url: "" });
  const host = await pluginHost({ botToken: "" });
  const prefsBefore = await host.rpc("preferences");
  const saved = await host.rpc("saveToken", { token: "654321:NEWtokenABCDEFGHIJKLMNOPQRSTUV" });
  const prefsAfter = await host.rpc("preferences");
  await host.rpc("sync");
  const offer = await host.rpc("pairing");
  const again = await host.rpc("pairing");
  const status = await host.rpc("status");
  const shown = JSON.stringify([saved, prefsAfter, offer, status]);
  const stored = { code: host.store.get("pair:code"), at: typeof host.store.get("pair:codeAt") };
  const mintClock = {
    nine: ((await withClock(9.5 * 60_000, () => host.rpc("pairing"))) as { code: string }).code,
    ten: ((await withClock(10 * 60_000 + 2000, () => host.rpc("pairing"))) as { code: string }).code,
  };
  host.store.put("owner:id", OWNER);
  const linked = await host.rpc("status");
  const afterPair = await host.rpc("pairing");
  const unpaired = await host.rpc("unpair");
  const gone = await host.rpc("status");
  const states: string[] = [];
  await host.harness.behavior.setSettings({ enabled: false });
  states.push((await host.rpc("status")).link);
  await host.harness.behavior.setSettings({ enabled: true });
  states.push((await host.rpc("status")).link);
  host.store.put("owner:id", OWNER);
  states.push((await host.rpc("status")).link);
  return {
    tokenBefore: [prefsBefore.tokenPresent, prefsBefore.tokenSource], tokenAfter: [prefsAfter.tokenPresent, prefsAfter.tokenSource], saved: [saved.valid, saved.username],
    leaked: shown.includes("NEWtoken") || shown.includes("SMAsecret"), offer, same: again.code === offer.code, stored, mintClock, linked: [linked.link, linked.owner],
    afterPair, unpaired, gone: [gone.link, gone.owner], states, requestTokens: [...new Set(tg.calls.map((c: { token: string }) => c.token))],
  };
});

// Disabled and token-less: n961.
out.null = await world(async (tg) => {
  const off = await pluginHost({ enabled: false });
  const a = off.harness.behavior.runService("telegram-ingress");
  await sleep(80);
  a.controller.abort();
  await a.done;
  const bare = await pluginHost({ botToken: "" });
  const b = bare.harness.behavior.runService("telegram-ingress");
  await sleep(80);
  b.controller.abort();
  await b.done;
  return { calls: tg.calls.length, state: off.store.keys(), link: (await off.rpc("status")).link, error: (await bare.rpc("status")).ingressError };
});

// The poll and the backoff: n962, n963.
out.poll = await world(async (tg, timers) => {
  const host = await paired();
  tg.script.push([{ update_id: 7, message: { message_id: 1, from: { id: OWNER }, chat: { id: -5, type: "supergroup" }, text: "hi" } }]);
  await runUntilDrained(host, tg);
  const polls = tg.calls.filter((c: { method: string }) => c.method === "getUpdates");
  const failing = await paired();
  tg.script.push("network", { code: 409, description: "Conflict" }, "html", "network", "network", "network", "network", [], "network");
  timers.delays.length = 0;
  await runUntilDrained(failing, tg);
  return { bodies: polls.map((c: { body: unknown }) => c.body), deadlines: polls.map((c: { deadline: number }) => c.deadline), delays: timers.delays.filter((d: number) => d >= 10_000), error: (await failing.rpc("status")).ingressError };
});

// The router and the loop: n964, n965, n966, n967, n969.
out.route = await world(async (tg) => {
  const sentence = "Этот бот работает только со своим владельцем.";
  const strangers = await paired();
  tg.script.push([update(1, 99, "привет"), update(2, 99, "ты тут?"), update(3, 100, "эй")]);
  await runUntilDrained(strangers, tg);
  const stranger = { sent: tg.sent().map((b: { chat_id: number; text: string }) => [b.chat_id, b.text]), rows: strangers.store.keys("chat:in:"), sdk: strangers.harness.inspection.sdk.calls.length, owner: strangers.store.get("owner:id") };
  tg.calls.length = 0;

  const pairing = await pluginHost();
  const { code } = await pairing.rpc("pairing");
  tg.script.push([update(1, 55, "/start WRONG222"), { update_id: 2, message: { message_id: 20, from: { id: 56 }, chat: { id: -100, type: "supergroup" }, text: "/start " + code } }, update(3, 57, "/start")]);
  await runUntilDrained(pairing, tg);
  const before = { owner: (await pairing.rpc("status")).owner, sent: tg.sent().length };
  tg.script.push([update(5, 55, "/start " + code)]);
  await runUntilDrained(pairing, tg);
  const pair = { before, owner: (await pairing.rpc("status")).owner, told: tg.sent().map((b: { chat_id: number; text: string }) => [b.chat_id, b.text]), codeLeft: (await pairing.rpc("pairing")).code };
  const old = await pluginHost();
  const oldCode = (await old.rpc("pairing")).code;
  tg.script.push([update(1, 55, "/start " + oldCode)]);
  await withClock(10 * 60_000 + 1000, () => runUntilDrained(old, tg));
  const expired = (await old.rpc("status")).owner;
  tg.calls.length = 0;

  const brain = await pluginHost({ chatEnabled: true });
  const brainCode = (await brain.rpc("pairing")).code;
  const chat = brain.harness.behavior.runService("telegram-chat");
  tg.script.push([update(1, 55, "/start " + brainCode), update(2, 55, "собери мне сайт"), update(3, 66, "я чужой")]);
  await runUntilDrained(brain, tg);
  const row = () => brain.store.get("chat:in:2") as { state: string; input: { ownerId: number; chatId: number } } | undefined;
  const reached = await waitFor(() => row()?.state === "done" && tg.sent().length === 3);
  chat.controller.abort();
  await chat.done;
  const words = {
    reached, owner: brain.store.get("owner:id"), rows: brain.store.keys("chat:in:"), row: [row()?.input.ownerId, row()?.input.chatId],
    to55: tg.sent().filter((b: { chat_id: number }) => b.chat_id === 55).length, to66: tg.sent().filter((b: { chat_id: number }) => b.chat_id === 66).map((b: { text: string }) => b.text),
  };
  tg.calls.length = 0;

  const off = await paired({ chatEnabled: false });
  tg.script.push([update(1, OWNER, "привет"), update(2, OWNER, "эй, ты тут?")]);
  await runUntilDrained(off, tg);
  const first = tg.sent().map((b: { text: string }) => b.text);
  tg.script.push([update(3, OWNER, "ну?")]);
  await withClock(3_600_000 + 5000, () => runUntilDrained(off, tg));
  const noBrain = { first, rows: off.store.keys("chat:in:"), second: tg.sent().length, link: (await off.rpc("status")).link };
  tg.calls.length = 0;

  const sticker = await paired();
  tg.script.push([update(1, OWNER, undefined, { sticker: { file_id: "s" }, message_thread_id: 7 })]);
  await runUntilDrained(sticker, tg);
  const refused = tg.sent().map((b: { message_thread_id?: number; text: string }) => [b.message_thread_id, b.text]);
  return { sentence, stranger, pair, expired, words, noBrain, refused };
});

// The bridge built from the settings: n960, n979.
out.bridge = await world(async (tg) => {
  const dir = mkdtempSync(join(tmpdir(), "sma-r10-companion-"));
  try {
    const control = join(dir, "telegram-chat.json");
    const state = () => (existsSync(control) ? (JSON.parse(readFileSync(control, "utf8")) as { enabled: boolean }).enabled : undefined);
    const host = await paired({ chatEnabled: true, companionDir: dir });
    const held = host.harness.behavior.runService("telegram-ingress");
    await sleep(80);
    held.controller.abort();
    await held.done;
    const heldCalls = tg.calls.length;
    const chat = host.harness.behavior.runService("telegram-chat");
    const built = await waitFor(() => state() === true);
    tg.script.push([update(1, OWNER, "работаем")]);
    await runUntilDrained(host, tg);
    const polled = tg.calls.some((c: { method: string }) => c.method === "getUpdates");
    const rows = host.store.keys("chat:in:");
    await host.harness.behavior.setSettings({ chatEnabled: false });
    const down = await waitFor(() => state() === false);
    await host.harness.behavior.setSettings({ chatEnabled: true });
    const rebuilt = await waitFor(() => state() === true);
    await host.harness.behavior.setSettings({ enabled: false });
    const off = await waitFor(() => state() === false);
    chat.controller.abort();
    await chat.done;
    return { heldCalls, built, polled, rows, down, rebuilt, off };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
out.wake = await (async () => {
  const tg = fakeTelegram();
  try {
    const host = await pluginHost({ language: "ru" }, { subscribe: () => () => {} });
    const sync = host.harness.behavior.runService("project-task-sync");
    const getMe = () => tg.calls.filter((c: { method: string }) => c.method === "getMe").length;
    await waitFor(() => getMe() === 1);
    await sleep(100);
    const quiet = getMe();
    const started = Date.now();
    await host.harness.behavior.setSettings({ language: "en" });
    const woke = await waitFor(() => getMe() === 2, 2500);
    const took = Date.now() - started;
    sync.controller.abort();
    await sync.done;
    return { quiet, woke, quick: took < 2500 };
  } finally {
    tg.restore();
  }
})();

// The client and the redaction: n973, n974.
out.client = await world(async (tg) => {
  const call = telegram(async () => TOKEN, new AbortController().signal, 12_345, () => OWNER);
  tg.script.push([]);
  await call("getUpdates", { offset: 0, timeout: 25 });
  await call("sendMessage", { text: "hi", message_thread_id: 7 });
  await call("sendMessage", { text: "hey", strangerChatId: 99 });
  await call("sendChatAction", { action: "typing" });
  await call("getMe", {});
  const shapes = tg.calls.map((c: { method: string; body: unknown; deadline: number }) => [c.method, c.body, c.deadline]);
  const real = globalThis.fetch;
  const leak = async (): Promise<string[]> => {
    const seen: string[] = [];
    const bare = telegram(async () => TOKEN, new AbortController().signal);
    const stubs: Array<typeof fetch> = [
      (async (url: unknown) => { throw new TypeError(`fetch failed: request to ${String(url)} failed`); }) as typeof fetch,
      (async () => new Response("<html>" + TOKEN + "</html>", { status: 502 })) as typeof fetch,
      (async (url: unknown) => new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized " + String(url) }), { status: 401 })) as typeof fetch,
    ];
    for (const stub of stubs) {
      globalThis.fetch = stub;
      try {
        await bare("getMe", {});
      } catch (e) {
        seen.push(`${(e as { code?: string }).code}:${[String(e), (e as Error).stack ?? "", JSON.stringify(e)].join(" ").includes("SMAsecret")}`);
      }
    }
    return seen;
  };
  try {
    return { shapes, errors: await leak() };
  } finally {
    globalThis.fetch = real;
  }
});

// The chat bridge on a stand-in BB: n967 (attachments), n968, n970, n972.
out.chat = await (async () => {
  const f = bridgeSup.bridgeFixture();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await f.bridge.handle(f.input("Собери мне лендинг"));
    await f.bridge.handle(f.input("И добавь форму"));
    const brain = f.calls.map((c: [string, { prompt?: string; input?: unknown; threadId?: string; visibility?: string }]) => [c[0], c[1].prompt ?? c[1].input, c[1].threadId ?? c[1].visibility]);
    const typing = () => f.sent.filter((c: { method: string }) => c.method === "sendChatAction").length;
    const signs: number[] = [];
    await f.bridge.observe();
    signs.push(typing());
    f.thread.status = "active";
    await f.bridge.observe();
    await f.bridge.observe();
    signs.push(typing());
    clock += 4000;
    await f.bridge.observe();
    signs.push(typing());
    clock += 1000;
    await f.bridge.observe();
    signs.push(typing());
    const photo = { update_id: 4, message: { message_id: 13, from: { id: OWNER }, chat: { id: OWNER, type: "private" }, message_thread_id: 100, photo: [{ file_id: "p" }] } };
    const route = routeUpdate(photo, OWNER);
    const g = bridgeSup.bridgeFixture();
    if (route.kind === "chat") await g.bridge.handle(route.input);
    await g.bridge.flush();
    const attachment = { kind: route.kind, text: route.kind === "chat" ? route.input.text : null, started: g.calls.length, said: g.sent.filter((c: { method: string }) => c.method === "sendMessage").map((c: { text: string }) => c.text) };
    g.cleanup();
    const sticker = routeUpdate({ update_id: 1, message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: "private" }, sticker: {} } }, OWNER);
    const d = bridgeSup.bridgeFixture({ confirmNewChat: true });
    await d.bridge.handle(d.input("Напиши стихотворение"));
    const waiting = { started: d.calls.length, draft: d.data.get("chat:draft:100") };
    await d.bridge.handle(d.input("Лучше напиши рассказ"));
    await d.bridge.handle(d.input("да"));
    const draft = { waiting, started: d.calls.map((c: [string, { prompt?: string }]) => [c[0], c[1].prompt]), left: d.data.has("chat:draft:100") };
    d.cleanup();
    f.cleanup();
    return { brain, signs, attachment, sticker, draft };
  } finally {
    Date.now = realNow;
  }
})();
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
