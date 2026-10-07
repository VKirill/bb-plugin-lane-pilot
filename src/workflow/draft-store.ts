import { randomUUID } from "node:crypto";
import type { LanePilotDatabase } from "../database";
import { applyDraftOps, checkDraft, newDraftDefinition, slugWorkflowId } from "./draft";
import type { DraftCheck, DraftOp, DraftScope, RawDefinition, Refusal } from "./draft";
import type { DraftTestResult } from "./draft-test";
import type { ValidateOptions } from "./validate";

/** Appended to the plugin's migrations (append only): drafts of workflows and their version history. */
export const draftMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_draft (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('global','project')),
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','tested','published')) DEFAULT 'draft',
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    tests_json TEXT,
    tested_version INTEGER,
    published_version INTEGER,
    published_path TEXT,
    published_sha256 TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_wf_draft_project ON lane_pilot_wf_draft(project_id, updated_at)`,
  `CREATE TABLE lane_pilot_wf_draft_version (
    draft_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    ops_json TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY(draft_id, version)
  )`,
];

export type DraftStatus = "draft" | "tested" | "published";
export type DraftTests = { version: number; at: number; green: boolean; results: DraftTestResult[] };

export type DraftRow = {
  id: string;
  projectId: string;
  threadId: string | null;
  scope: DraftScope["level"];
  workflowId: string;
  status: DraftStatus;
  /** Counts the changes of the draft; the open screen compares it to know it is behind. */
  version: number;
  definition: RawDefinition;
  tests: DraftTests | null;
  testedVersion: number | null;
  publishedVersion: number | null;
  publishedPath: string | null;
  publishedSha256: string | null;
  createdAt: number;
  updatedAt: number;
};

type Raw = {
  id: string; project_id: string; thread_id: string | null; scope: DraftScope["level"]; workflow_id: string; status: DraftStatus; version: number;
  definition_json: string; tests_json: string | null; tested_version: number | null; published_version: number | null; published_path: string | null;
  published_sha256: string | null; created_at: number; updated_at: number;
};

const toRow = (raw: Raw): DraftRow => ({
  id: raw.id, projectId: raw.project_id, threadId: raw.thread_id, scope: raw.scope, workflowId: raw.workflow_id, status: raw.status, version: raw.version,
  definition: JSON.parse(raw.definition_json) as RawDefinition, tests: raw.tests_json ? JSON.parse(raw.tests_json) as DraftTests : null,
  testedVersion: raw.tested_version, publishedVersion: raw.published_version, publishedPath: raw.published_path, publishedSha256: raw.published_sha256,
  createdAt: raw.created_at, updatedAt: raw.updated_at,
});

export type PatchResult =
  | { ok: true; draft: DraftRow; check: DraftCheck; changes: string[] }
  | { ok: false; reason: "not_found" | "version_conflict" | "refused"; refused?: Refusal[]; currentVersion?: number };

export function createDraftStore(db: LanePilotDatabase, now: () => number = Date.now) {
  const get = (id: string): DraftRow | null => {
    const raw = db.prepare("SELECT * FROM lane_pilot_wf_draft WHERE id=?").get(id) as Raw | undefined;
    return raw ? toRow(raw) : null;
  };

  return {
    get,

    create(input: { projectId: string; threadId: string | null; scope: DraftScope["level"]; name: string | { en: string; ru: string }; description: string | { en: string; ru: string }; workflowId?: string }): DraftRow {
      const id = `wfd_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const nameText = typeof input.name === "string" ? input.name : input.name.en;
      const workflowId = input.workflowId ?? slugWorkflowId(nameText, id.slice(-4));
      const definition = newDraftDefinition({ id: workflowId, name: input.name, description: input.description, scope: { level: input.scope, ...(input.scope === "project" ? { projectId: input.projectId } : {}) } });
      const at = now();
      db.transaction(() => {
        db.prepare(`INSERT INTO lane_pilot_wf_draft(id,project_id,thread_id,scope,workflow_id,status,version,definition_json,created_at,updated_at) VALUES (?,?,?,?,?,'draft',1,?,?,?)`)
          .run(id, input.projectId, input.threadId, input.scope, workflowId, JSON.stringify(definition), at, at);
        db.prepare("INSERT INTO lane_pilot_wf_draft_version(draft_id,version,definition_json,summary,ops_json,at) VALUES (?,?,?,?,NULL,?)").run(id, 1, JSON.stringify(definition), "created", at);
      })();
      return get(id)!;
    },

    /** The drafts of a project, newest change first. */
    list(projectId: string, options: { threadId?: string; limit?: number } = {}): DraftRow[] {
      const rows = (options.threadId
        ? db.prepare("SELECT * FROM lane_pilot_wf_draft WHERE project_id=? AND thread_id=? ORDER BY updated_at DESC LIMIT ?").all(projectId, options.threadId, options.limit ?? 50)
        : db.prepare("SELECT * FROM lane_pilot_wf_draft WHERE project_id=? ORDER BY updated_at DESC LIMIT ?").all(projectId, options.limit ?? 50)) as Raw[];
      return rows.map(toRow);
    },

    /** Applies operations as one new version. An operation that cannot be applied refuses all of them and saves nothing. */
    patch(draftId: string, ops: readonly DraftOp[], options: { expectedVersion?: number; validate?: ValidateOptions } = {}): PatchResult {
      return db.transaction((): PatchResult => {
        const draft = get(draftId);
        if (!draft) return { ok: false, reason: "not_found" };
        if (options.expectedVersion !== undefined && options.expectedVersion !== draft.version) return { ok: false, reason: "version_conflict", currentVersion: draft.version };
        const applied = applyDraftOps(draft.definition, ops);
        if (!applied.ok) return { ok: false, reason: "refused", refused: applied.refused };
        const definitionId = typeof applied.definition.id === "string" ? applied.definition.id : draft.workflowId;
        const version = draft.version + 1, at = now();
        const json = JSON.stringify(applied.definition);
        // Any change takes the draft back to «draft»: the tests and the publication were for another version.
        db.prepare("UPDATE lane_pilot_wf_draft SET definition_json=?, workflow_id=?, version=?, status='draft', updated_at=? WHERE id=? AND version=?")
          .run(json, definitionId, version, at, draftId, draft.version);
        db.prepare("INSERT INTO lane_pilot_wf_draft_version(draft_id,version,definition_json,summary,ops_json,at) VALUES (?,?,?,?,?,?)")
          .run(draftId, version, json, applied.changes.join("; ").slice(0, 2000), JSON.stringify(ops), at);
        return { ok: true, draft: get(draftId)!, check: checkDraft(applied.definition, options.validate), changes: applied.changes };
      })();
    },

    /** Stores the results of a test run of the current version; the draft is `tested` only when every case ran (`complete`) and is green. */
    recordTests(draftId: string, version: number, results: DraftTestResult[], complete = true): DraftRow | null {
      const draft = get(draftId);
      if (!draft || draft.version !== version) return draft;
      const green = complete && results.length > 0 && results.every((result) => result.green);
      const tests: DraftTests = { version, at: now(), green, results };
      db.prepare("UPDATE lane_pilot_wf_draft SET tests_json=?, tested_version=?, status=?, updated_at=? WHERE id=? AND version=?")
        .run(JSON.stringify(tests), version, green ? "tested" : "draft", now(), draftId, version);
      return get(draftId);
    },

    markPublished(draftId: string, input: { version: number; path: string; sha256: string; workflowVersion: number }): DraftRow | null {
      db.prepare("UPDATE lane_pilot_wf_draft SET status='published', published_version=?, published_path=?, published_sha256=?, updated_at=? WHERE id=? AND version=?")
        .run(input.workflowVersion, input.path, input.sha256, now(), draftId, input.version);
      return get(draftId);
    },

    history(draftId: string, limit = 50): Array<{ version: number; summary: string; at: number }> {
      return db.prepare("SELECT version, summary, at FROM lane_pilot_wf_draft_version WHERE draft_id=? ORDER BY version DESC LIMIT ?").all(draftId, limit) as Array<{ version: number; summary: string; at: number }>;
    },

    definitionAt(draftId: string, version: number): RawDefinition | null {
      const raw = db.prepare("SELECT definition_json FROM lane_pilot_wf_draft_version WHERE draft_id=? AND version=?").get(draftId, version) as { definition_json: string } | undefined;
      return raw ? JSON.parse(raw.definition_json) as RawDefinition : null;
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
