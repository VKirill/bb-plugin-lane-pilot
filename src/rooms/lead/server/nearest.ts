import { routeIntent, stems, type Workflow } from "@lane-pilot/workflow-engine";
import { candidateNames, readSkillTreeText, skillCatalog, skillTreeCached, type ListedSkill, type SkillTree } from "../../platform/server";

import type { ServerCore } from "../../contracts/server";
import type { ProcessForm } from "./tick";

import type { WorkflowEngineApi } from "../../platform/server";


/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
}

/**
 * Stream G/R8: the nearest catalog units of a graphless group and the form hypothesis. The graphs come from the same
 * deterministic router the driver uses (`routeIntent`, no model); the skills from `skillCatalog` narrowed by the skill
 * tree the writer already keeps (`candidateNames`). Both are ranked and cut to four. The form is a hypothesis the tick
 * shows the agent — the agent may still name another of the five forms, the code only refuses what it does not know.
 */
export type NearestUnit = { kind: "graph" | "skill"; id: string; score: number };

/** What `graphlessErrands` knows about a group's runs, for the form hypothesis. */
export type GroupSignals = { repeatedTrace: "ok" | "failed" | null; providers: number };
export type FormHint = { form: ProcessForm; why: string };

/** The four nearest units of one group: router candidates of the graphs plus the best-overlapping catalog skills. */
export const NEAREST_MAX = 4;
/** A skill counts as «the same family» when it covers at least this share of the group's content words (stems). */
export const SKILL_NEAR_SCORE = 0.5;

export type CatalogDeps = { workflows: Workflow[]; skills: ListedSkill[]; tree: SkillTree | null };

/** The group's runs show a gate, a timetable or helpers of different kinds — only a graph carries those (the old G2 rule, now a signal). */
const SCHEDULE_WORDS = /cron|расписан|ежеднев|еженедельно|каждый день|каждую неделю|ежемесяч|schedule/iu;
const GATE_WORDS = /оплат|плат[её]ж|деньг|publish|публикац|отправ|send|delete|удал|письм|email|invoice|счёт|счет|договор|money/iu;

/** ponytail: gate/schedule words are a regex over the sample titles plus provider diversity — a ceiling (a process can
 * hide its gate in the task text, not the title). */
export function graphSignalsOf(row: { samples: string[]; signals: GroupSignals }): boolean {
  if (row.signals.providers >= 2) return true;
  const text = row.samples.join("\n");
  return SCHEDULE_WORDS.test(text) || GATE_WORDS.test(text);
}

export async function nearestUnits(text: string, deps: CatalogDeps): Promise<NearestUnit[]> {
  const intent = text.trim();
  // intent routing is advisory; null just means graph candidates come only from scores
  const routed = deps.workflows.length ? await routeIntent({ intent, workflows: deps.workflows, model: null }).catch(() => null) : null;
  const graphs = (routed?.candidates ?? []).map((candidate) => ({ kind: "graph" as const, id: candidate.id, score: candidate.score }));
  const query = stems(intent);
  const catalog = skillCatalog(deps.skills);
  const names = new Set(deps.tree && intent ? candidateNames(deps.tree, intent) : []);
  // candidateNames returns [] when nothing matched: the whole catalog stays the pool then (its own contract).
  const pool = names.size ? catalog.filter((entry) => names.has(entry.name) || names.has(entry.name.slice(entry.name.lastIndexOf(":") + 1))) : catalog;
  const doc = new Set<string>();
  const skills = pool.flatMap((entry) => {
    doc.clear();
    for (const word of stems(`${entry.name} ${entry.description ?? ""}`)) doc.add(word);
    const shared = query.filter((word) => doc.has(word)).length;
    const score = query.length ? shared / query.length : 0;
    return score > 0 ? [{ kind: "skill" as const, id: entry.name, score }] : [];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return [...graphs, ...skills].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, NEAREST_MAX);
}

/**
 * The form a group deserves, from what is near and what the runs did. Order: a repeated command sequence is a script
 * (or a trap, when the same call keeps failing); a gate/schedule/multi-helper shape is a graph; a near skill of the
 * same family takes a new variant as a reference (or a rule when the family's runs keep failing); with nothing near,
 * a new skill.
 */
export function formHypothesis(input: { nearest: NearestUnit[]; signals: GroupSignals; graphSignals: boolean }): FormHint {
  const { nearest, signals } = input;
  if (signals.repeatedTrace === "ok") return { form: "script", why: "the same command sequence ran in at least three episodes: a fixed sequence is a script" };
  if (input.graphSignals) return { form: "graph", why: "the runs show a gate, a schedule or different helpers: only a graph carries those" };
  const near = nearest.find((unit) => unit.kind === "skill" && unit.score >= SKILL_NEAR_SCORE);
  if (near) {
    return signals.repeatedTrace === "failed"
      ? { form: "rule", why: `the same call keeps failing and ${near.id} is the family it belongs to: a trap to write down` }
      : { form: "reference", why: `${near.id} is near and this is a new variant of its family: a file under its references/` };
  }
  if (signals.repeatedTrace === "failed") return { form: "rule", why: "the same call keeps failing in at least three episodes: a trap to write down" };
  return { form: "skill", why: "nothing in the catalog is near: a new skill" };
}

type EnrichableRow = {
  kind: string; samples: string[]; projects: string[];
  signals: GroupSignals; nearest: NearestUnit[]; hint: FormHint | null;
};

/**
 * Fills `nearest` and `hint` of every graphless row, once per tick: the graph catalog is read once, the skill tree once,
 * the skills list once per project. When the skills list cannot be read the row proposes nothing this tick (`hint` stays
 * null) and one `lead_nearest_unavailable` line is logged — a proposal without its nearest units would guess blind.
 */
export async function attachNearest(input: {
  bb: ServerCore["bb"];
  workflowCatalog: Services["workflowCatalog"] | undefined;
  fallbackProjectId: string | null;
  rows: EnrichableRow[];
  log: (message: string) => void;
  /** The skill tree reader; tests pass their own so no `bb` CLI is spawned. */
  readTree?: () => Promise<SkillTree | null>;
}): Promise<void> {
  const { bb, rows } = input;
  if (!rows.length) return;
  const workflows = input.workflowCatalog
    ? await input.workflowCatalog.store().then((store) => store.list().map((item) => item.workflow)).catch(() => input.workflowCatalog!.builtins()) // an unreadable catalog falls back to the built-in workflows
    : [];
  // an unreadable skill tree just means no tree-based candidates
  const tree = await (input.readTree ?? (() => skillTreeCached(readSkillTreeText)))().catch(() => null);
  const skillsCache = new Map<string, Promise<ListedSkill[] | null>>();
  const skillsOf = (projectId: string): Promise<ListedSkill[] | null> => {
    let pending = skillsCache.get(projectId);
    if (!pending) {
      const list = bb.sdk.skills?.list as ((args: { projectId: string; environmentId: null }) => Promise<{ skills?: Array<{ name?: unknown; description?: unknown }> }>) | undefined;
      pending = list
        ? list.call(bb.sdk.skills, { projectId, environmentId: null })
            .then((listed) => (listed?.skills ?? []).flatMap((skill) => (typeof skill?.name === "string" && skill.name ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : null }] : [])))
            // an unreadable skill list just means no skills for that project
            .catch(() => null)
        : Promise.resolve(null);
      skillsCache.set(projectId, pending);
    }
    return pending;
  };
  let unavailableLogged = false;
  for (const row of rows) {
    const projectId = row.projects[0] ?? input.fallbackProjectId;
    const skills = projectId ? await skillsOf(projectId) : [];
    if (projectId && skills === null) {
      row.nearest = [];
      row.hint = null;
      if (!unavailableLogged) {
        unavailableLogged = true;
        input.log(`lead_nearest_unavailable: the skills list of project ${projectId} could not be read: its graphless groups propose nothing this tick`);
      }
      continue;
    }
    const units = await nearestUnits(row.samples.join("\n") || row.kind, { workflows, skills: skills ?? [], tree });
    row.nearest = units;
    row.hint = formHypothesis({ nearest: units, signals: row.signals, graphSignals: graphSignalsOf(row) });
  }
}
