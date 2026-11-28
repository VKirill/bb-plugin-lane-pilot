import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { QUALITY_MODE_SETTING, resolveQualityMode, type RepoTrustOutput } from "../../../contracts";
import { WORKSPACE_MODE_SETTING } from "../../../native-agent";
import type { GitProbe } from "../../../project-git";
import { createProjectGit, type ProjectGitDeps } from "../../../project-git/server";
import { countRevertReceiptsSince } from "../../../rollback/server";
import { acceptanceStats } from "../../../runs/server";
import { readProjectSetting } from "../../../settings/server";
import { landingWordAsked } from "../../../tasks";
import {
  fullGateVerdict,
  latestGateRun,
  loadProjectSettings,
  sectionBindingId,
  type GateRunRow,
  type LanePilotDatabase,
} from "../../../storage";
import {
  TRUST_WINDOW_DAYS,
  TRUST_WINDOW_MS,
  buildTrustRules,
  computeTrustLevel,
} from "../../models/trust-level";

/** A path the gate's data class recognises as a migration (tasks/models/sensitive.ts DATA_PATH). */
const MIGRATION_EXAMPLE_PATH = "migrations/0001_example.sql";

export type RepoTrustInput = {
  projectId: string;
  sectionId?: string;
};

type SectionSummary = {
  id: string;
  parentId: string | null;
  hostId: string;
  path: string;
  paths: Array<{ hostId: string; path: string }>;
};

export interface RepoTrustCtx {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  host: ProjectGitDeps["host"];
  ownerAsk: ProjectGitDeps["ownerAsk"];
  log: (message: string) => void;
  listProjectSections: (projectId: string) => Promise<SectionSummary[]>;
  sectionChain: (sections: Array<{ id: string; parentId: string | null }>, sectionId: string) => string[];
}

export interface RepoTrustDeps {
  probe?: (hostId: string, folder: string) => Promise<GitProbe>;
  projectPlace?: (projectId: string) => Promise<{
    sectionId: string | null;
    folderPath: string | null;
    hostId: string | null;
  } | null>;
  now?: () => number;
}

type ProbeTarget = {
  hostId: string | null;
  folderPath: string | null;
};

async function resolveTargetAndScopes(
  ctx: RepoTrustCtx,
  input: RepoTrustInput,
  deps: RepoTrustDeps,
): Promise<{ target: ProbeTarget; scopes: string[] }> {
  const [place, sections] = await Promise.all([
    deps.projectPlace ? deps.projectPlace(input.projectId).catch(() => null) : Promise.resolve(null),
    input.sectionId ? ctx.listProjectSections(input.projectId).catch(() => [] as SectionSummary[]) : Promise.resolve([] as SectionSummary[]),
  ]);

  let scopes: string[] = [];
  let hostId: string | null = place?.hostId ?? null;
  let folderPath: string | null = place?.folderPath ?? null;

  if (input.sectionId) {
    const chain = ctx.sectionChain(sections, input.sectionId);
    scopes = chain.length > 0 ? chain : [sectionBindingId(input.sectionId)];
    const section = sections.find((row) => row.id === input.sectionId);
    if (section) {
      const preferred = (hostId ? section.paths.find((p) => p.hostId === hostId) : undefined) ?? section.paths[0];
      hostId = preferred?.hostId ?? (section.hostId || hostId);
      folderPath = preferred?.path ?? (section.path || folderPath);
    }
  }

  if (!hostId || !folderPath) {
    let project: { sources?: Array<{ hostId?: string; path?: string }> } | null = null;
    try {
      project = (await orMiss(ctx.bb.sdk.projects.get({ projectId: input.projectId }), null, isNotFound)) as {
        sources?: Array<{ hostId?: string; path?: string }>;
      } | null;
    } catch {
      project = null;
    }
    const source = project?.sources?.[0];
    hostId = hostId ?? source?.hostId ?? null;
    folderPath = folderPath ?? source?.path ?? null;
  }

  return { target: { hostId, folderPath }, scopes };
}

function recordedTestCount(row: GateRunRow | undefined): number | null {
  if (!row) return null;
  const raw = (row as GateRunRow & { testCount?: unknown }).testCount;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function probeErrorReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Builds a read-only repository trust summary from Lane Pilot gate runs, revert receipts, acceptance stats, and settings. */
export async function repoTrust(
  ctx: RepoTrustCtx,
  input: RepoTrustInput,
  deps: RepoTrustDeps = {},
): Promise<RepoTrustOutput> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const { target, scopes } = await resolveTargetAndScopes(ctx, input, deps);

  const probeFn =
    deps.probe ??
    createProjectGit({
      host: ctx.host,
      kv: ctx.bb.storage.kv,
      ownerAsk: ctx.ownerAsk,
      log: ctx.log,
      activeLiveRun: async () => null,
    }).probe;

  let repoRoot: string | null = null;
  let repoRemote: string | null = null;
  let head: string | null = null;

  if (target.hostId && target.folderPath) {
    try {
      const probed = await probeFn(target.hostId, target.folderPath);
      if (probed.state === "unknown") {
        ctx.log(`[repo-trust] probe failed project=${input.projectId}: ${probed.reason ?? "unknown"}`);
      } else if (probed.state === "origin" || probed.state === "localNoOrigin") {
        repoRoot = probed.root ?? null;
        repoRemote = probed.state === "origin" ? (probed.origin ?? null) : null;
        head = typeof probed.head === "string" && probed.head.trim() ? probed.head.trim() : null;
      }
    } catch (cause) {
      ctx.log(`[repo-trust] probe failed project=${input.projectId}: ${probeErrorReason(cause)}`);
    }
  }

  const row = latestGateRun(ctx.db, input.projectId);
  const verdict = row ? fullGateVerdict(row, head, nowMs) : null;
  const fresh = Boolean(row && row.state === "passed" && head !== null && verdict?.ok);
  const gate: RepoTrustOutput["gate"] = row
    ? {
        state: row.state,
        at: row.updatedAt,
        fresh,
        reason:
          row.reason ??
          (row.state === "passed" && fresh
            ? null
            : row.state === "passed" && head === null
              ? "repository head unavailable"
              : (verdict?.reason ?? null)),
      }
    : {
        state: "none",
        at: null,
        fresh: false,
        reason: null,
      };

  const rollbacks30d = countRevertReceiptsSince(ctx.db, input.projectId, nowMs - TRUST_WINDOW_MS);
  const stats = acceptanceStats(ctx.db, TRUST_WINDOW_DAYS, input.projectId);
  const acceptedFirstTry30d =
    stats.totals.dispatched > 0
      ? Math.round((stats.totals.firstTryAccepted / stats.totals.dispatched) * 1000) / 1000
      : null;

  const qualityMode = resolveQualityMode(
    null,
    readProjectSetting(ctx.db, input.projectId, QUALITY_MODE_SETTING, { scopes }).value,
  );
  const workspaceMode = readProjectSetting(ctx.db, input.projectId, WORKSPACE_MODE_SETTING, { scopes }).value;
  // The landing gate (writer post-validation) decides with landingWordAsked on these same settings; asking it about an ordinary
  // task and a migration task keeps the summary from promising an unasked landing the gate would hold.
  const wordSettings = loadProjectSettings(ctx.db, input.projectId, scopes);
  const landingWord = {
    ordinary: landingWordAsked(wordSettings, undefined, {}),
    migration: landingWordAsked(wordSettings, undefined, { paths: [MIGRATION_EXAMPLE_PATH] }),
  };

  return {
    repo: {
      root: repoRoot,
      remote: repoRemote,
    },
    gate,
    tests: {
      lastCount: recordedTestCount(row),
    },
    rollbacks30d,
    acceptedFirstTry30d,
    level: computeTrustLevel({ gateState: gate.state, fresh: gate.fresh, rollbacks30d }),
    rules: buildTrustRules({ qualityMode, workspaceMode, landingWord }),
  };
}
