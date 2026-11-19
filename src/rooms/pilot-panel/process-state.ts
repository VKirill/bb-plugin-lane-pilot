import { z } from "zod";

export const PILOT_PROCESS_STATE_REL_PATH = ".agents/pilot/process-state.json";

export const pilotApprovedBaselineSchema = z.object({
  path: z.string().min(1).max(400),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  label: z.string().max(200).optional(),
}).strict();

export const pilotProcessStateSchema = z.object({
  stage: z.string().min(1).max(120),
  workflowId: z.string().max(120).nullable().default(null),
  approvedDesignBaseline: pilotApprovedBaselineSchema.nullable().default(null),
  rejectedVariants: z.array(z.string().max(200)).max(20).default([]),
  activeSkills: z.array(z.string().max(100)).max(20).default([]),
  notes: z.string().max(600).optional(),
  updatedAt: z.string(),
}).strict();

export type PilotApprovedBaseline = z.infer<typeof pilotApprovedBaselineSchema>;
export type PilotProcessState = z.infer<typeof pilotProcessStateSchema>;

export interface ProcessStateIo {
  read: (relPath: string) => Promise<{ exists: boolean; content: string; sha256: string | null }>;
  write: (args: { relPath: string; content: string; expectedSha256: string | null }) => Promise<"written" | "conflict" | "skipped">;
  onEngineWrite?: (rootPath: string, relPath: string) => void;
  redact?: (text: string) => string;
}

const syncCache = new Map<string, PilotProcessState>();

function normalizeRootKey(rootPath: string | null | undefined): string {
  return typeof rootPath === "string" ? rootPath.replace(/\/+$/, "") : "";
}

export function getCachedProcessState(rootPath: string | null | undefined): PilotProcessState | null {
  const key = normalizeRootKey(rootPath);
  return key ? syncCache.get(key) ?? null : null;
}

export function setCachedProcessState(rootPath: string | null | undefined, state: PilotProcessState | null): void {
  const key = normalizeRootKey(rootPath);
  if (!key) return;
  if (!state) syncCache.delete(key);
  else syncCache.set(key, state);
}

export function parsePilotProcessState(
  raw: string,
): { ok: true; state: PilotProcessState } | { ok: false; reason: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message.slice(0, 120) : "invalid_json" };
  }
  const parsed = pilotProcessStateSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "schema_mismatch" };
  }
  return { ok: true, state: parsed.data };
}

export function serializePilotProcessState(state: PilotProcessState): string {
  const validated = pilotProcessStateSchema.parse(state);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function emitProcessLog(
  log: ((msg: string) => void) | undefined,
  redact: ((text: string) => string) | undefined,
  level: "DEBUG" | "INFO" | "WARN",
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!log) return;
  if (level === "DEBUG") {
    const envLevel = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL?.trim().toLowerCase();
    if (envLevel && envLevel !== "debug") return;
  }
  const body = redact ? redact(JSON.stringify(payload)) : JSON.stringify(payload);
  log(`${level} [pilotPanel.processState] ${event} ${body}`);
}

export async function readPilotProcessStateCas(
  io: ProcessStateIo,
  opts: { hostId: string; rootPath: string; log?: (msg: string) => void },
): Promise<{ state: PilotProcessState | null; sha256: string | null; error?: string }> {
  const file = await io.read(PILOT_PROCESS_STATE_REL_PATH);
  if (!file.exists) {
    setCachedProcessState(opts.rootPath, null);
    return { state: null, sha256: null };
  }
  const parsed = parsePilotProcessState(file.content);
  if (!parsed.ok) {
    emitProcessLog(opts.log, io.redact, "WARN", "invalid_json", {
      hostId: opts.hostId,
      rootPath: opts.rootPath,
      reason: parsed.reason,
    });
    return {
      state: null,
      sha256: file.sha256,
      error: "Повреждён .agents/pilot/process-state.json",
    };
  }
  setCachedProcessState(opts.rootPath, parsed.state);
  emitProcessLog(opts.log, io.redact, "DEBUG", "loaded", {
    stage: parsed.state.stage,
    workflowId: parsed.state.workflowId,
  });
  return { state: parsed.state, sha256: file.sha256 };
}

export async function writePilotProcessStateCas(
  io: ProcessStateIo,
  opts: {
    hostId: string;
    rootPath: string;
    state: PilotProcessState;
    expectedSha256: string | null;
    log?: (msg: string) => void;
  },
): Promise<{ ok: true; state: PilotProcessState } | { ok: false; conflict: boolean; error: string }> {
  const validated = pilotProcessStateSchema.parse(opts.state);
  const content = serializePilotProcessState(validated);
  io.onEngineWrite?.(opts.rootPath, PILOT_PROCESS_STATE_REL_PATH);
  try {
    const outcome = await io.write({
      relPath: PILOT_PROCESS_STATE_REL_PATH,
      content,
      expectedSha256: opts.expectedSha256,
    });
    if (outcome === "conflict") {
      emitProcessLog(opts.log, io.redact, "WARN", "cas_conflict", {
        hostId: opts.hostId,
        rootPath: opts.rootPath,
        stage: validated.stage,
      });
      return { ok: false, conflict: true, error: "CAS-конфликт при записи .agents/pilot/process-state.json" };
    }
    setCachedProcessState(opts.rootPath, validated);
    emitProcessLog(opts.log, io.redact, "INFO", "saved", {
      stage: validated.stage,
      workflowId: validated.workflowId,
    });
    return { ok: true, state: validated };
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    const isConflict = /conflict|sha_mismatch|CAS write refused/i.test(msg);
    emitProcessLog(opts.log, io.redact, "WARN", isConflict ? "cas_conflict" : "write_failed", {
      hostId: opts.hostId,
      rootPath: opts.rootPath,
      reason: msg.slice(0, 140),
    });
    return { ok: false, conflict: isConflict, error: msg };
  }
}

export function formatProcessStatePromptLine(state: PilotProcessState | null | undefined): string {
  if (!state) return "";
  const parts = [`Стадия процесса: ${state.stage}`];
  if (state.workflowId) parts.push(`граф=${state.workflowId}`);
  if (state.approvedDesignBaseline) {
    const base = state.approvedDesignBaseline;
    parts.push(`baseline=${base.path}#${base.sha256.slice(0, 8)}`);
  }
  if (state.activeSkills.length > 0) parts.push(`скиллы=[${state.activeSkills.join(", ")}]`);
  if (state.rejectedVariants.length > 0) parts.push(`отклонено=[${state.rejectedVariants.join(", ")}]`);
  return `Контекст .agents/pilot/process-state.json: ${parts.join("; ")}.`;
}
