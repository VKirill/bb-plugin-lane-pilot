import { randomBytes } from "node:crypto";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { authorize } from "../../policy";
import { saveProjectSetting } from "../../storage";
import type { ServerCore, Services } from "../../core/server";
import { armsOf, SEEDED, type HypothesisState } from "../logic";

type Row = { id: string; title: string; source: string; settings_json: string; state: HypothesisState; set_version: string | null; verdict_json: string | null; previous_json: string | null; created_at: number; updated_at: number };
export type Hypothesis = { id: string; title: string; source: string; settings: Record<string, unknown>; state: HypothesisState; setVersion: string | null; verdict: unknown; arms: { base: string; test: string } };
const view = (row: Row): Hypothesis => ({ id: row.id, title: row.title, source: row.source, settings: JSON.parse(row.settings_json) as Record<string, unknown>, state: row.state,
  setVersion: row.set_version, verdict: row.verdict_json ? JSON.parse(row.verdict_json) as unknown : null, arms: armsOf(row.id) });

export function createHypotheses(ctx: ServerCore, services: Services) {
  const { db } = ctx;
  const get = (id: string): Hypothesis | null => { const row = db.prepare("SELECT * FROM lane_pilot_hypothesis WHERE id=?").get(id) as Row | undefined; return row ? view(row) : null; };
  const setState = (id: string, state: HypothesisState, extra: { setVersion?: string; verdict?: unknown; previous?: unknown } = {}) => db.prepare(`UPDATE lane_pilot_hypothesis SET state=?, updated_at=?,
    set_version=COALESCE(?, set_version), verdict_json=COALESCE(?, verdict_json), previous_json=COALESCE(?, previous_json) WHERE id=?`)
    .run(state, Date.now(), extra.setVersion ?? null, extra.verdict === undefined ? null : JSON.stringify(extra.verdict), extra.previous === undefined ? null : JSON.stringify(extra.previous), id);

  function add(input: { id?: string; title: string; source: string; settings: Record<string, unknown> }): Hypothesis {
    if (!input.title.trim() || !input.source.trim()) throw new Error("a hypothesis needs a title and where it comes from (--source)");
    if (!Object.keys(input.settings).length) throw new Error("a hypothesis names the settings that carry it (--setting key=value)");
    const id = input.id ?? `h${randomBytes(4).toString("hex")}`;
    const now = Date.now();
    db.prepare("INSERT OR IGNORE INTO lane_pilot_hypothesis(id,title,source,settings_json,state,created_at,updated_at) VALUES (?,?,?,?,'proposed',?,?)")
      .run(id, input.title.trim().slice(0, 300), input.source.trim().slice(0, 500), JSON.stringify(input.settings), now, now);
    return get(id)!;
  }

  function seed(): number { return SEEDED.filter((item) => !get(item.id) && add({ ...item, settings: { ...item.settings } })).length; }

  /** Starts both arms on the newest (or the named) bench set: the baseline with no setting of its own, the test arm with the hypothesis's. */
  async function test(id: string, options: { version?: string; tasks?: number } = {}) {
    const hypothesis = get(id);
    if (!hypothesis) throw new Error(`no hypothesis ${id}`);
    const version = options.version ?? services.bench.status().slice().sort((a, b) => b.createdAt - a.createdAt)[0]?.version;
    if (!version) throw new Error("no bench set yet: bb lane-pilot bench build");
    const limit = options.tasks ? { limit: options.tasks } : {};
    const base = await services.bench.run({ version, arm: hypothesis.arms.base, settings: {}, ...limit });
    const test = await services.bench.run({ version, arm: hypothesis.arms.test, settings: hypothesis.settings, ...limit });
    setState(id, "benching", { setVersion: version });
    return { id, version, started: { base, test } };
  }

  /** Compares the arms; a pass goes to the night policy, which applies the settings globally (adopted) or keeps them off (held). */
  function verdict(id: string) {
    const hypothesis = get(id);
    if (!hypothesis?.setVersion) throw new Error(`hypothesis ${id} has not been benched: bb lane-pilot hypothesis test ${id}`);
    const { comparison, text } = services.bench.compare({ version: hypothesis.setVersion, armA: hypothesis.arms.base, armB: hypothesis.arms.test });
    // Too little measured is neither a rejection nor a pass: the hypothesis stays on the bench until the arms are run to completion.
    if (comparison.verdict === "inconclusive") { setState(id, "benching", { verdict: comparison }); return { id, state: "benching" as const, text }; }
    if (comparison.verdict !== "pass") { setState(id, "rejected", { verdict: comparison }); return { id, state: "rejected" as const, text }; }
    const decision = authorize({ kind: "setting_change", settings: Object.keys(hypothesis.settings), attrs: { bench_passed: true, auto_revertible: true } });
    if (decision.tier !== "night_decides") { setState(id, "held", { verdict: { comparison, policy: decision } }); return { id, state: "held" as const, text, policy: decision.reason }; }
    const previous = Object.fromEntries(Object.keys(hypothesis.settings).map((key) => [key, (db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").get(GLOBAL_SETTINGS_PROJECT_ID, key) as { value: string } | undefined)?.value ?? null]));
    for (const [key, value] of Object.entries(hypothesis.settings)) saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, key, value);
    setState(id, "adopted", { verdict: { comparison, policy: decision }, previous });
    ctx.log(`hypothesis ${id} adopted: ${JSON.stringify(hypothesis.settings)}`);
    return { id, state: "adopted" as const, text };
  }

  /** Undoes an adopted hypothesis: the old global values come back (absent ones are removed). */
  function revert(id: string) {
    const row = db.prepare("SELECT * FROM lane_pilot_hypothesis WHERE id=?").get(id) as Row | undefined;
    if (!row || row.state !== "adopted") throw new Error(`hypothesis ${id} is not adopted`);
    for (const [key, value] of Object.entries(JSON.parse(row.previous_json ?? "{}") as Record<string, string | null>)) {
      if (value === null) db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").run(GLOBAL_SETTINGS_PROJECT_ID, key);
      else saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, key, JSON.parse(value) as unknown);
    }
    setState(id, "rejected");
    return get(id)!;
  }

  const list = () => (db.prepare("SELECT * FROM lane_pilot_hypothesis ORDER BY created_at").all() as Row[]).map(view);
  return { hypotheses: { add, seed, test, verdict, revert, list, get } };
}
export type HypothesesApi = ReturnType<typeof createHypotheses>["hypotheses"];
