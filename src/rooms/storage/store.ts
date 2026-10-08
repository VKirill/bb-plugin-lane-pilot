import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Workflow } from "../workflow";
import { loadWorkflow, validateWorkflow } from "../workflow/validate";
import type { WorkflowProblem } from "../workflow";
import { sha256Hex } from "@lane-pilot/kit";

/** Where workflow files are read from: the hub's disk here, the host of a project's machine later. */
export type WorkflowFileSource = {
  /** Paths of the `.json` files in a directory; a missing directory is an empty list. */
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
};

export const nodeFileSource: WorkflowFileSource = {
  async list(dir) {
    try { return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort().map((name) => join(dir, name)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
  },
  read: (path) => readFile(path, "utf8"),
};

export const globalWorkflowDir = (home = homedir()) => join(home, ".lane-pilot", "workflows");
export const projectWorkflowDir = (projectCwd: string) => join(projectCwd, ".lane-pilot", "workflows");

export type WorkflowOrigin = "builtin" | "global" | "project";
export type StoredWorkflow = { workflow: Workflow; origin: WorkflowOrigin; source: string; sha256: string; warnings: WorkflowProblem[] };
export type StoreProblem = { origin: WorkflowOrigin; source: string; problems: WorkflowProblem[] };

export type WorkflowStore = {
  list(): StoredWorkflow[];
  get(id: string): StoredWorkflow | null;
  /** The workflow a subworkflow node or the router asks for. */
  resolve(id: string, version?: number): Workflow | null;
  problems: StoreProblem[];
};

const RANK: Record<WorkflowOrigin, number> = { builtin: 0, global: 1, project: 2 };
/** The hash of what a workflow does: the places of its steps on the canvas (`ui`) are left out, so dragging a card does not make a published workflow «another version» with no test receipt. */
export const definitionSha256 = (workflow: Workflow): string => { const { ui: _ui, ...rest } = workflow; return sha256Hex(JSON.stringify(rest)); };
/** The hash before 0.1.194, with `ui` in it: a receipt written then is still honoured for the same file. */
export const legacyDefinitionSha256 = (workflow: Workflow): string => sha256Hex(JSON.stringify(workflow));

/**
 * Loads the three sources and keeps, per id, the narrowest valid one (project over global over built-in). A file that does
 * not pass the checks is reported and never loaded, so it cannot shadow a good workflow of a wider scope. Subworkflow
 * references are checked against the merged set.
 */
export async function loadWorkflowStore(input: {
  builtin: ReadonlyArray<{ name: string; value: unknown }>;
  files?: WorkflowFileSource;
  globalDir?: string;
  projectDir?: string;
  /** The status a workflow has here when it is not the one its file says (untested files, a live run that lifted a tested chain). */
  resolveStatus?: (item: StoredWorkflow) => { status: Workflow["status"]; notes: WorkflowProblem[] };
}): Promise<WorkflowStore> {
  const raw: Array<{ origin: WorkflowOrigin; source: string; text: unknown }> = input.builtin.map((item) => ({ origin: "builtin" as const, source: item.name, text: item.value }));
  const files = input.files ?? nodeFileSource;
  const problems: StoreProblem[] = [];
  for (const [origin, dir] of [["global", input.globalDir], ["project", input.projectDir]] as const) {
    if (!dir) continue;
    let paths: string[] = [];
    try { paths = await files.list(dir); } catch (cause) { problems.push({ origin, source: dir, problems: [{ level: "error", code: "read", message: `cannot list ${dir}: ${cause instanceof Error ? cause.message : String(cause)}` }] }); }
    for (const path of paths) {
      try { raw.push({ origin, source: path, text: await files.read(path) }); }
      catch (cause) { problems.push({ origin, source: path, problems: [{ level: "error", code: "read", message: `cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}` }] }); }
    }
  }

  // Pass 1: structure and the checks that need no other workflow.
  const first = new Map<string, StoredWorkflow>();
  const parsed: StoredWorkflow[] = [];
  for (const item of raw) {
    const loaded = loadWorkflow(item.text);
    if (!loaded.ok) { problems.push({ origin: item.origin, source: item.source, problems: loaded.problems }); continue; }
    parsed.push({ workflow: loaded.workflow, origin: item.origin, source: item.source, sha256: definitionSha256(loaded.workflow), warnings: loaded.warnings });
  }
  for (const item of parsed.sort((a, b) => RANK[a.origin] - RANK[b.origin])) first.set(item.workflow.id, item);

  // Pass 2: references between workflows, against the merged set.
  const resolve = (id: string, version?: number) => {
    const found = first.get(id)?.workflow ?? null;
    return found && (version === undefined || found.version === version) ? found : null;
  };
  const final = new Map<string, StoredWorkflow>();
  for (const [id, item] of first) {
    const issues = validateWorkflow(item.workflow, { resolve });
    if (issues.some((issue) => issue.level === "error")) { problems.push({ origin: item.origin, source: item.source, problems: issues }); continue; }
    const verdict = input.resolveStatus?.(item);
    final.set(id, verdict && verdict.status !== item.workflow.status
      ? { ...item, workflow: { ...item.workflow, status: verdict.status }, warnings: [...issues, ...verdict.notes] }
      : { ...item, warnings: issues });
  }
  return {
    list: () => [...final.values()],
    get: (id) => final.get(id) ?? null,
    resolve: (id, version) => {
      const found = final.get(id)?.workflow ?? null;
      return found && (version === undefined || found.version === version) ? found : null;
    },
    problems,
  };
}
