import { routeIntent, stems, type Workflow } from "@lane-pilot/workflow-engine";
import { candidateNames, readSkillTreeText, skillCatalog, skillTreeCached, type ListedSkill, type SkillTree, type WorkflowEngineApi } from "../../../platform/server";
import type { ServerCore } from "../../../contracts/server";
import { NEAREST_MAX, SKILL_NEAR_SCORE, formHypothesis, graphSignalsOf, type FormHint, type GroupSignals, type NearestUnit } from "../../models/nearest";

export { NEAREST_MAX, SKILL_NEAR_SCORE, formHypothesis, graphSignalsOf, type FormHint, type GroupSignals, type NearestUnit };

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
}

export type CatalogDeps = { workflows: Workflow[]; skills: ListedSkill[]; tree: SkillTree | null };

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
