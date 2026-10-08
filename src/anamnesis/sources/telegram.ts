import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { monthOf, spread, type SourceRecord, type SourceScan } from "./common";

/**
 * The owner's own Telegram channels (A10), off until the owner switches the source on and names the channels. It is the
 * `telegram-user` skill's reading command, `tg history <channel>`, nothing else: no dialog list, no private chat, no send, no
 * download. Only counts, months and hashtags are kept: a channel becomes a project (posts per month), a hashtag the owner used in
 * three posts or more becomes an interest; a post's text never enters the store, and evidence is a pointer to the post.
 * The session lives on the Mac mini, so this runs there (the host side), like git.
 */
export const MIN_POSTS_FOR_TAG = 3;
const LIMIT = 500;

export type TgRunner = (args: string[]) => Promise<string>;

/** `~/toolkit/telegram/tg`, or `$TG_TOOLKIT_ROOT/tg` where the BB machine environment sets it. */
export const tgPath = (home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string => join(env.TG_TOOLKIT_ROOT || join(home, "toolkit", "telegram"), "tg");

const runTg = (path: string): TgRunner => (args) => new Promise((resolve, reject) => {
  execFile(path, args, { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(new Error(`tg ${args[0] ?? ""} failed: ${error.message.split("\n")[0]?.slice(0, 160)}`)) : resolve(stdout)));
});

export type TgPost = { id: number; at: number; tags: string[] };

/** The posts of one `tg history` answer (JSON lines). A line with an `error` is the tool's own refusal and fails the channel. */
export function parseHistory(output: string): TgPost[] {
  const posts: TgPost[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof row.error === "string") throw new Error(`tg: ${row.error}${typeof row.detail === "string" ? ` (${row.detail.slice(0, 120)})` : ""}`);
    const id = Number(row.id), at = Date.parse(String(row.date ?? "").replace(" ", "T"));
    if (!Number.isInteger(id) || !Number.isFinite(at)) continue;
    const text = typeof row.text === "string" ? row.text : "";
    const tags = [...new Set([...text.matchAll(/(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]{3,40})/gu)].map((match) => match[1]!.toLowerCase()))];
    posts.push({ id, at, tags });
  }
  return posts;
}

/** `@name`, `t.me/name` or `https://t.me/name` to the form `tg` and the evidence use; null for anything else. */
export function channelName(input: string): string | null {
  const text = input.trim();
  const link = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(text);
  if (link) return `@${link[1]}`;
  return /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text) ? text : null;
}

export type TelegramOptions = { channels: readonly string[]; since: number; until: number; home?: string; tg?: TgRunner };

export async function scanTelegram(options: TelegramOptions): Promise<SourceScan> {
  const records: SourceRecord[] = [];
  const channels = options.channels.map((channel) => channelName(channel)).filter((channel): channel is string => channel !== null);
  if (!channels.length) return { source: "telegram", items: 0, records, note: "no channel named: set your own channels with `bb lane-pilot anamnesis config --telegram-channels @name`" };
  const tg = options.tg ?? runTg(tgPath(options.home));
  let items = 0;
  for (const channel of [...new Set(channels)]) {
    const posts = parseHistory(await tg(["history", channel, "--limit", String(LIMIT), "--after", new Date(options.since).toISOString(), "--before", new Date(options.until).toISOString()]));
    if (!posts.length) continue;
    items += posts.length;
    posts.sort((a, b) => a.at - b.at);
    const ref = (post: TgPost): string => `tg:${channel}/${post.id}`;
    const byMonth: Record<string, number> = {};
    for (const post of posts) byMonth[monthOf(post.at)] = (byMonth[monthOf(post.at)] ?? 0) + 1;
    records.push({
      kind: "project", key: `telegram:${channel}`, title: `Telegram channel ${channel}`,
      statement: `${posts.length} posts, ${monthOf(posts[0]!.at)} to ${monthOf(posts.at(-1)!.at)}`,
      attributes: { origin: "telegram", channel, posts: posts.length, byMonth }, confidence: 0.9, firstSeen: posts[0]!.at, lastSeen: posts.at(-1)!.at,
      evidence: spread(posts, 12).map((post) => ({ source: "telegram" as const, ref: ref(post), at: post.at })),
    });
    const byTag = new Map<string, TgPost[]>();
    for (const post of posts) for (const tag of post.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), post]);
    for (const [tag, list] of byTag) {
      if (list.length < MIN_POSTS_FOR_TAG) continue;
      records.push({
        kind: "interest", key: `tg-tag:${tag}`, title: `#${tag}`, statement: `Wrote about it in ${list.length} posts of ${channel}, ${monthOf(list[0]!.at)} to ${monthOf(list.at(-1)!.at)}`,
        attributes: { origin: "telegram", channel, posts: list.length }, confidence: 0.6, firstSeen: list[0]!.at, lastSeen: list.at(-1)!.at,
        evidence: spread(list, 10).map((post) => ({ source: "telegram" as const, ref: ref(post), at: post.at })),
      });
    }
  }
  return { source: "telegram", items, records, ...(records.length ? {} : { note: "no post in the window" }) };
}
