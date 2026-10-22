import type Database from "better-sqlite3";
import { closeOwnerItem, collectOwnerWaiting, postOwnerItem, type OwnerWaiting, type PostOwnerItem } from "./items";
import { ackDigest, loadPushConfig, planDigest, savePushConfig, PUSH_CONFIG_KEYS } from "./push";

export const WAITING_USAGE = [
  "bb lane-pilot waiting [--json]                  everything only the owner can decide: what, why it is his, evidence, the exact action; plus what went red overnight and what was accepted",
  "bb lane-pilot waiting digest [--json]           the Telegram message for NEW wake items now (empty in quiet hours, when disabled or when nothing is new); sends nothing",
  "bb lane-pilot waiting ack <key> [key …]         the keys of a digest went out: they never push again",
  "bb lane-pilot waiting config [enabled=on|off] [quiet=23:00-08:00] [timezone=Europe/Madrid]   show or set the push settings",
  "bb lane-pilot waiting post '<json>'             (night loop) open a waiting: {key, source, kind, what, why, projectId?, wake?, evidence?, actions?}",
  "bb lane-pilot waiting close <key> --by <text>   (night loop) the waiting is settled",
].join("\n");

type Db = Pick<Database.Database, "prepare">;
type Result = { exitCode: number; stdout?: string; stderr?: string };
const json = (value: unknown) => JSON.stringify(value, null, 2);

const SECTION: Record<string, string> = {
  deferral_overdue: "Просрочено (учение красное)", night: "От ночного цикла", wall: "Стены", backlog: "Бэклог", memory_conflict: "Конфликты памяти",
  rule_proposal: "Правила на решение", learning: "Выводы из твоих слов", deferral_term: "Отсрочки без срока",
};

export function renderWaiting(waiting: OwnerWaiting): string {
  const lines: string[] = [];
  const bySource = new Map<string, typeof waiting.items>();
  for (const item of waiting.items) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item]);
  lines.push(waiting.items.length ? `Ждут владельца: ${waiting.items.length}. Ничего не блокируется.` : "Владельца ничто не ждёт.");
  for (const [source, items] of bySource) {
    lines.push("", `${SECTION[source] ?? source} (${items.length})`);
    for (const item of items) {
      lines.push(`- [${item.key}] ${item.what}`, `    почему твоё: ${item.why}`);
      for (const evidence of item.evidence) lines.push(`    ${evidence.kind}: ${evidence.ref}${evidence.label ? ` (${evidence.label})` : ""}`);
      for (const action of item.actions) lines.push(`    ${action.label}: ${action.cli}${action.needsOwnerMessage ? "   (нужно твоё сообщение)" : ""}`);
    }
  }
  const { red, accepted, rulesAdopted, rulesConfirmed } = waiting.overnight;
  lines.push("", `Красное за сутки: ${red.length ? red.map((row) => `${row.state} ${row.count} (${row.attempts.join(", ")})`).join("; ") : "ничего"}.`, `Принято: ${accepted} попыток, правил на пробу ${rulesAdopted}, подтверждено ${rulesConfirmed}.`);
  return lines.join("\n");
}

export function runWaitingCli(db: Db, argv: string[], now: number = Date.now()): Result {
  try {
    const flags = argv.filter((word) => word.startsWith("--"));
    const words = argv.filter((word) => !word.startsWith("--"));
    const asJson = flags.includes("--json");
    const [op, ...rest] = words;
    if (!op) {
      const waiting = collectOwnerWaiting(db, now);
      return { exitCode: 0, stdout: asJson ? json(waiting) : renderWaiting(waiting) };
    }
    if (op === "digest") {
      const digest = planDigest(db, now);
      return { exitCode: 0, stdout: asJson ? json(digest) : digest.send ? digest.text : `nothing to send (${digest.reason})` };
    }
    if (op === "ack") {
      if (!rest.length) throw new Error("ack needs the keys of the digest");
      return { exitCode: 0, stdout: json({ acknowledged: ackDigest(db, rest, now) }) };
    }
    if (op === "config") {
      const patch = Object.fromEntries(rest.map((pair) => { const at = pair.indexOf("="); if (at < 1) throw new Error(`«${pair}» is not key=value (${PUSH_CONFIG_KEYS.join(", ")})`); return [pair.slice(0, at), pair.slice(at + 1)]; }));
      return { exitCode: 0, stdout: json(rest.length ? savePushConfig(db, patch, now) : loadPushConfig(db)) };
    }
    if (op === "post") {
      if (!rest[0]) throw new Error(`post needs a JSON object\n${WAITING_USAGE}`);
      return { exitCode: 0, stdout: json(postOwnerItem(db, JSON.parse(rest.join(" ")) as PostOwnerItem, now)) };
    }
    if (op === "close") {
      const at = argv.indexOf("--by");
      const by = at >= 0 ? argv[at + 1] : undefined;
      if (!rest[0] || !by) throw new Error("usage: bb lane-pilot waiting close <key> --by <text>");
      return { exitCode: 0, stdout: json({ closed: closeOwnerItem(db, rest[0], by, now) }) };
    }
    return { exitCode: 1, stderr: `unknown operation «${op}»\n${WAITING_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
