import { sha256Hex } from "@lane-pilot/kit";
import { dropMemoryIndexes, hideRecord, listMemoryByOrigin, storeMemoryRecords } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "./database";

export interface ProjectArtifactRow {
  project_id: string;
  artifact_id: string;
  domain: string;
  kind: string;
  rel_path: string;
  location: string;
  schema_version: number;
  revision: number;
  sha256: string;
  status: string;
  summary: string;
  producer_wf: string | null;
  producer_run_id: string | null;
  updated_at: number;
}

export interface UpsertProjectArtifactInput {
  projectId: string;
  artifactId: string;
  domain: string;
  kind: string;
  relPath: string;
  location?: "checkout" | "planning_home" | "db_only" | string;
  schemaVersion?: number;
  sha256?: string;
  content?: string;
  status?: "active" | "superseded" | "stale" | string;
  summary?: string;
  producerWf?: string | null;
  producerRunId?: string | null;
  syncMemory?: boolean;
  nowMs?: number;
}

function artifactTableReady(db: LanePilotDatabase): boolean {
  if (!db || typeof db.prepare !== "function") return false;
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'lane_pilot_artifact'")
      .get() as { ok?: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function syncArtifactMemoryNote(db: LanePilotDatabase, row: ProjectArtifactRow): void {
  try {
    const origin = `artifact:${row.artifact_id}`;
    const summaryPart = row.summary ? ` — ${row.summary.slice(0, 110)}` : "";
    const line = `Project artifact [${row.domain}/${row.kind}] (${row.artifact_id} r${row.revision}): ${row.rel_path}${summaryPart}`.slice(0, 230);
    const prev = listMemoryByOrigin(db as never, origin).filter((r) => r.projectId === row.project_id);
    for (const old of prev) {
      if (old.content === line) return;
      hideRecord(db as never, row.project_id, old.id, "superseded", null, (p, id) => dropMemoryIndexes(db as never, p, id), "owner");
    }
    storeMemoryRecords(db as never, {
      projectId: row.project_id,
      audience: "subagent",
      sourceSha256: row.sha256,
      entries: [{ kind: "note", content: line, concepts: ["artifact", row.domain, row.kind] }],
      coreBudget: 600,
      noteBudget: 1200,
      indexBudget: 500,
      trust: "confirmed",
      origin,
    });
  } catch {
    // Non-fatal in isolated DB tests where memory tables are absent
  }
}

export function getProjectArtifact(
  db: LanePilotDatabase,
  projectId: string,
  artifactIdOrRelPath: string,
): ProjectArtifactRow | null {
  if (!projectId || !artifactIdOrRelPath || !artifactTableReady(db)) return null;
  const row = db
    .prepare("SELECT * FROM lane_pilot_artifact WHERE project_id = ? AND artifact_id = ?")
    .get(projectId, artifactIdOrRelPath) as ProjectArtifactRow | undefined;
  if (row) return row;
  if (artifactIdOrRelPath.includes("/")) {
    const cleanRel = artifactIdOrRelPath.replace(/^\/+/, "");
    const byPath = db
      .prepare("SELECT * FROM lane_pilot_artifact WHERE project_id = ? AND rel_path = ? ORDER BY updated_at DESC LIMIT 1")
      .get(projectId, cleanRel) as ProjectArtifactRow | undefined;
    return byPath ?? null;
  }
  return null;
}

export function countActiveProjectArtifacts(db: LanePilotDatabase, projectId?: string): number {
  if (!artifactTableReady(db)) return 0;
  if (projectId) {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM lane_pilot_artifact WHERE project_id = ? AND status = 'active'")
        .get(projectId) as { n: number }
    ).n;
  }
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_artifact WHERE status = 'active'").get() as { n: number }).n;
}

export function upsertProjectArtifact(
  db: LanePilotDatabase,
  input: UpsertProjectArtifactInput,
): ProjectArtifactRow | null {
  if (!input.projectId || !input.artifactId || !artifactTableReady(db)) return null;
  const now = input.nowMs ?? Date.now();
  const relPath = input.relPath.replace(/^\/+/, "");
  const sha = input.sha256 || sha256Hex(input.content ?? `${input.artifactId}:${relPath}:${now}`);
  const location = input.location ?? "checkout";
  const schemaVersion = input.schemaVersion ?? 1;
  const status = input.status ?? "active";
  const summary = (input.summary ?? "").trim().slice(0, 500);
  const producerWf = input.producerWf ?? null;
  const producerRunId = input.producerRunId ?? null;

  const existing = getProjectArtifact(db, input.projectId, input.artifactId);
  const nextRevision = existing ? (existing.sha256 === sha ? existing.revision : existing.revision + 1) : 1;

  db.prepare(
    `INSERT INTO lane_pilot_artifact
      (project_id, artifact_id, domain, kind, rel_path, location, schema_version, revision, sha256, status, summary, producer_wf, producer_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, artifact_id) DO UPDATE SET
      domain = excluded.domain,
      kind = excluded.kind,
      rel_path = excluded.rel_path,
      location = excluded.location,
      schema_version = excluded.schema_version,
      revision = excluded.revision,
      sha256 = excluded.sha256,
      status = excluded.status,
      summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE lane_pilot_artifact.summary END,
      producer_wf = COALESCE(excluded.producer_wf, lane_pilot_artifact.producer_wf),
      producer_run_id = COALESCE(excluded.producer_run_id, lane_pilot_artifact.producer_run_id),
      updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    input.artifactId,
    input.domain,
    input.kind,
    relPath,
    location,
    schemaVersion,
    nextRevision,
    sha,
    status,
    summary,
    producerWf,
    producerRunId,
    now,
  );

  const saved = getProjectArtifact(db, input.projectId, input.artifactId);
  if (saved && input.syncMemory !== false && (!existing || existing.sha256 !== sha)) {
    syncArtifactMemoryNote(db, saved);
  }
  return saved;
}

export function listProjectArtifacts(
  db: LanePilotDatabase,
  projectId: string,
  filter: { domain?: string; kind?: string; status?: string; limit?: number } = {},
): ProjectArtifactRow[] {
  if (!projectId || !artifactTableReady(db)) return [];
  const clauses = ["project_id = ?"];
  const args: unknown[] = [projectId];
  if (filter.domain) {
    clauses.push("domain = ?");
    args.push(filter.domain);
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
  args.push(limit);
  return db
    .prepare(`SELECT * FROM lane_pilot_artifact WHERE ${clauses.join(" AND ")} ORDER BY domain ASC, artifact_id ASC LIMIT ?`)
    .all(...args) as ProjectArtifactRow[];
}

export function renderArtifactsManifestJson(db: LanePilotDatabase, projectId: string): string {
  const rows = listProjectArtifacts(db, projectId, { status: "active", limit: 500 });
  const latestAt = rows.reduce((mx, r) => Math.max(mx, r.updated_at), 0);
  const manifest = {
    schema: "lp.project-manifest/1",
    project_id: projectId,
    updated_at: latestAt,
    count: rows.length,
    artifacts: rows.map((r) => ({
      artifact_id: r.artifact_id,
      domain: r.domain,
      kind: r.kind,
      rel_path: r.rel_path,
      location: r.location,
      schema_version: r.schema_version,
      revision: r.revision,
      sha256: r.sha256,
      status: r.status,
      summary: r.summary,
      producer_wf: r.producer_wf,
      updated_at: r.updated_at,
    })),
  };
  return JSON.stringify(manifest, null, 2);
}

/** Infers canonical `(artifactId, domain, kind)` when `.agents/<domain>/...` is written on checkout. */
export function inferArtifactMetaFromRelPath(relPath: string): {
  artifactId: string;
  domain: string;
  kind: string;
} | null {
  const clean = relPath.replace(/^\/+/, "");
  if (!clean.startsWith(".agents/") || clean === ".agents/manifest.json") return null;
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const domain = parts[1]!;
  const file = parts[parts.length - 1]!;
  const stem = file
    .replace(/\.(json|jsonl|md|yaml|yml|txt)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  if (clean === ".agents/passport/PASSPORT.json") return { artifactId: "passport.main", domain: "passport", kind: "passport" };
  if (clean === ".agents/passport/BRANDCORE.md" || clean === ".agents/passport/BRANDCORE.projection.md") {
    return { artifactId: "passport.brandcore", domain: "passport", kind: "brandcore" };
  }
  if (clean === `.agents/${domain}/charter.json`) return { artifactId: `${domain}.charter`, domain, kind: "charter" };
  const subKind = parts.length >= 4 ? parts[2]! : stem || "doc";
  const artifactId = `${domain}.${subKind}.${stem || "item"}`.slice(0, 120);
  return { artifactId, domain, kind: subKind };
}

export interface CasFilesLike {
  read?: (args: { hostId: string; rootPath: string; path: string; maxBytes?: number }) => Promise<unknown>;
  write: (args: {
    hostId: string;
    rootPath: string;
    path: string;
    content: string;
    contentEncoding: "utf8";
    createParents: boolean;
    expectedSha256: string | null;
  }) => Promise<unknown>;
}

/**
 * Performs a read-then-CAS file write on a BB host (`ASTRA-F-001`):
 * - Reads current SHA256 when the file exists (`null` when absent so create-only still guards races).
 * - Retries once if a concurrent writer updated `currentSha256` between read and write.
 * - Verifies `outcome === "written"` whenever the SDK returns a structured `ReplaceFileResult`,
 *   preventing callers from updating PDAS `lane_pilot_artifact` when the file write was rejected.
 */
export async function writeCasCheckoutFile(
  filesApi: CasFilesLike,
  args: { hostId: string; rootPath: string; relPath: string; content: string },
): Promise<{ ok: boolean; relPath: string; sha256: string; outcome: string }> {
  const cleanRel = args.relPath.replace(/^\/+/, "");
  if (!cleanRel || cleanRel.split("/").includes("..") || cleanRel.includes("\0")) {
    throw new Error(`writeCasCheckoutFile: invalid relative path "${args.relPath}"`);
  }
  const fullPath = `${args.rootPath}/${cleanRel}`;
  let expectedSha256: string | null = null;

  if (typeof filesApi.read === "function") {
    try {
      const existing = await filesApi.read({
        hostId: args.hostId,
        rootPath: args.rootPath,
        path: fullPath,
        maxBytes: 2_000_000,
      });
      if (existing && typeof existing === "object") {
        const rec = existing as { sha256?: unknown; content?: unknown };
        if (typeof rec.sha256 === "string" && /^[a-f0-9]{64}$/i.test(rec.sha256)) {
          expectedSha256 = rec.sha256;
        } else if (typeof rec.content === "string") {
          expectedSha256 = sha256Hex(rec.content);
        }
      }
    } catch {
      expectedSha256 = null;
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await filesApi.write({
      hostId: args.hostId,
      rootPath: args.rootPath,
      path: fullPath,
      content: args.content,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256,
    });
    if (!res || typeof res !== "object") {
      return { ok: true, relPath: cleanRel, sha256: sha256Hex(args.content), outcome: "written" };
    }
    if (!("outcome" in res)) {
      const legacy = res as { ok?: unknown; error?: unknown };
      if (legacy.ok === false || (typeof legacy.error === "string" && legacy.error.trim().length > 0)) {
        return {
          ok: false,
          relPath: cleanRel,
          sha256: sha256Hex(args.content),
          outcome: typeof legacy.error === "string" && legacy.error.trim() ? legacy.error.trim() : "error",
        };
      }
      return { ok: true, relPath: cleanRel, sha256: sha256Hex(args.content), outcome: "written" };
    }
    const outObj = res as { outcome?: unknown; currentSha256?: unknown };
    if (outObj.outcome === "written") {
      return { ok: true, relPath: cleanRel, sha256: sha256Hex(args.content), outcome: "written" };
    }
    if (
      attempt === 0 &&
      outObj.outcome === "conflict" &&
      (typeof outObj.currentSha256 === "string" || outObj.currentSha256 === null)
    ) {
      expectedSha256 = outObj.currentSha256;
      continue;
    }
    return {
      ok: false,
      relPath: cleanRel,
      sha256: sha256Hex(args.content),
      outcome: String(outObj.outcome ?? "conflict"),
    };
  }

  return { ok: false, relPath: cleanRel, sha256: sha256Hex(args.content), outcome: "conflict" };
}
