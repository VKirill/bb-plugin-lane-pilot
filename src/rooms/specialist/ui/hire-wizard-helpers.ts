import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import {
  DRILL_SANDBOX_PROJECT_IDS,
  isSandboxProjectName,
  userVisibleProjects,
  type AgentListItem,
  type ListedProject,
} from "../../contracts/ui";
import { domainOfAgent, UNLISTED_DEVELOPER_IDS } from "./staff-list-parts";

const SANDBOX_IDS = new Set<string>(DRILL_SANDBOX_PROJECT_IDS);

export function filterHireAgents(rows: ReadonlyArray<AgentListItem>): AgentListItem[] {
  return rows.filter(
    (agent) =>
      agent.kind !== "coordinator" &&
      agent.kind !== "internal" &&
      (agent.edited || !UNLISTED_DEVELOPER_IDS.has(agent.id)),
  );
}

export function filterHireProjects(
  rows: ReadonlyArray<ListedProject>,
  hiddenProjectIds?: ReadonlySet<string>,
): ListedProject[] {
  return userVisibleProjects([...rows]).filter(
    (project) =>
      !SANDBOX_IDS.has(project.id) &&
      !isSandboxProjectName(project.name) &&
      !hiddenProjectIds?.has(project.id),
  );
}

export type HireStep = 1 | 2 | 3;

export type SectionRow = {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  kind: "folder" | "group";
};

export type WorkflowInputField = NonNullable<
  z.infer<(typeof rpcContract)["workflow_get"]["output"]>["workflow"]
>["inputs"][number];

export type WorkflowRunResult = z.infer<(typeof rpcContract)["workflow_run"]["output"]>;

export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function isCharteredAgent(agent: AgentListItem): boolean {
  const dom = domainOfAgent(agent);
  return dom === "marketing" || dom === "seo";
}

export function intakeWorkflowIdOf(agent: AgentListItem): "mkt-project-intake" | "seo-project-intake" {
  return domainOfAgent(agent) === "seo" ? "seo-project-intake" : "mkt-project-intake";
}

export function flattenHireSections(
  sections: ReadonlyArray<SectionRow>,
): Array<{ id: string; name: string; depth: number }> {
  const ids = new Set(sections.map((item) => item.id));
  const flat: Array<{ id: string; name: string; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const section of sections.filter((item) => item.parentId === parentId)) {
      if (seen.has(section.id)) continue;
      seen.add(section.id);
      flat.push({ id: section.id, name: section.name, depth });
      walk(section.id, depth + 1);
    }
  };
  walk(null, 1);
  for (const section of sections) {
    if (seen.has(section.id)) continue;
    if (section.parentId && ids.has(section.parentId)) continue;
    seen.add(section.id);
    flat.push({ id: section.id, name: section.name, depth: 1 });
    walk(section.id, 2);
  }
  return flat;
}

export function buildInitialIntakeValues(
  fields: ReadonlyArray<WorkflowInputField>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (field.default === undefined) continue;
    out[field.name] =
      field.type === "boolean"
        ? field.default === true
        : typeof field.default === "string"
          ? field.default
          : JSON.stringify(field.default);
  }
  return out;
}

export function collectIntakeInputs(
  fields: ReadonlyArray<WorkflowInputField>,
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.type === "boolean") {
      if (raw !== undefined) out[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    if (field.type === "string" || field.type === "enum") {
      out[field.name] = text;
      continue;
    }
    try {
      out[field.name] = JSON.parse(text);
    } catch {
      out[field.name] = text;
    }
  }
  return out;
}
