import { sha256Hex } from "@lane-pilot/kit";
import { postOwnerItem } from "../../owner-waiting";
import { analysisPrompt } from "../brief";
import { buildClassPack, type CheckedFinding, type EvidencePack } from "../pack";
import { getWall, insertWall, updateWall, updateClassLadder, listRepairs } from "../store";
import type { WallCtx } from "./context";
import type { HuntApi } from "./hunt";

export function createBacklog(ctx: WallCtx, hunting: HuntApi) {
  const { db, ports, log } = ctx;
  const config = ctx.config;
  const { readAnalysis, packPathFor, dropPackFile, huntBudgetLeft } = hunting;

  async function escalateBacklog(key: string, subject: string, projectId: string, why: string, now: number, extra: { classKey?: string } = {}): Promise<string> {
    const cfg = await config();
    const existing = getWall(db, key);
    if (existing?.deferralId) return existing.deferralId;
    const id = `dfr_wall_${sha256Hex(key).slice(0, 10)}`;
    // The backlog item is the wall row (state backlog, `id` kept as its handle) and the owner's morning line below; no deferral is opened for it:
    // a term nobody sets would turn red by itself in a list nobody reads (Fable's recheck, E8).
    insertWall(db, { key, kind: key.startsWith("class:") ? "class" : "task", subject, projectId, state: "backlog", moves: 0, now });
    updateWall(db, key, { state: "backlog", deferralId: id }, now);
    if (extra.classKey) updateClassLadder(db, extra.classKey, { stage: "backlog" }, now);
    // The full analysis: a strong reader, the night's budget; written into the wall so a person starts from it.
    const wall = getWall(db, key)!;
    if (!wall.analysis && huntBudgetLeft(cfg, now) > 0) {
      const pack = (wall.pack as EvidencePack | null) ?? (extra.classKey ? buildClassPack(db, extra.classKey) : null);
      if (pack) {
        const history = [`wall ${key}`, ...listRepairs(db, extra.classKey ? { classKey: extra.classKey } : {}).map((row) => `round ${row.round} (${row.role}) ${row.state}: ${row.outcome ?? ""}`)];
        const run = await readAnalysis(key, analysisPrompt({ subject, pack, findings: ((wall.findings as { findings?: CheckedFinding[] } | null)?.findings) ?? [], history, packPath: await packPathFor(pack, `analysis-${key}`, "analysis") }));
        await dropPackFile(pack);
        updateWall(db, key, { analysis: { text: run.text, at: ports.now() }, tokensUsed: (wall.tokensUsed ?? 0) + run.tokens }, ports.now());
      }
    }
    // One line on the morning list per subject that reached the backlog: what the machine did and where the analysis is. It informs; nothing waits for the owner.
    const done = getWall(db, key)!;
    const verdicts = ((done.findings as { findings?: CheckedFinding[] } | null)?.findings ?? []).filter((row) => row.verdict !== "unknown").map((row) => `${row.angle}: ${row.verdict} -> ${row.action}`);
    const ran = Boolean(done.findings);
    postOwnerItem(db, { key: `wall:${key}`, source: "wall", kind: "loop_exhausted", projectId: projectId || null, wake: false,
      what: `Система остановилась и отложила работу: ${subject.slice(0, 240)}`,
      why: [(done.pack as EvidencePack | null)?.meta?.done, why.slice(0, 160) + ".",
        ran ? (verdicts.length ? `Три независимых проверяющих: ${verdicts.join("; ")}.` : "Проверяющие не нашли ничего, что подтверждается цитатами.") : "Проверяющие не запускались.",
        "Ничего делать не нужно: разбор и предложенный следующий шаг сохранены для того, кто возьмёт эту работу. Вмешайтесь, только если нужен другой объём."].filter(Boolean).join(" "),
      evidence: [{ kind: "command", ref: `bb lane-pilot wall show ${key}` }, { kind: "note", ref: id, label: "backlog" }] }, now);
    log(`wall: ${subject} went to the backlog (${why}) as ${id}`);
    return id;
  }

  return { escalateBacklog };
}
export type EscalateBacklog = ReturnType<typeof createBacklog>["escalateBacklog"];
