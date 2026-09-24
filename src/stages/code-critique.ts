import { createHash } from "node:crypto";
import { z } from "zod";

export const CODE_CRITIQUE_STAGE = "code-critique" as const;
export const CODE_CRITIQUE_MAX_ROUNDS = 3;

export const codeCritiqueFindingSchema = z.object({
  id: z.string().min(1).max(80),
  severity: z.enum(["info", "warning", "blocking"]),
  finding: z.string().min(1).max(1000),
  criterion: z.string().min(1).max(500),
  path: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().min(1).max(2000).optional(),
  impact: z.string().min(1).max(500).optional(),
  trigger: z.string().min(1).max(500).optional(),
  verificationExpectation: z.string().min(1).max(500).optional(),
}).strict();

export const codeCritiqueResultSchema = z.object({
  decision: z.enum(["approve", "changes_requested"]),
  summary: z.string().min(1).max(2000),
  findings: z.array(codeCritiqueFindingSchema).max(30),
}).strict();

export type CodeCritiqueFinding = z.infer<typeof codeCritiqueFindingSchema>;
export type CodeCritiqueResult = z.infer<typeof codeCritiqueResultSchema>;

export type CritiqueFilePacket = {
  path: string;
  sha256: string | null;
  baselineSha256: string | null;
  content: string;
  diff: string;
};

export type CritiqueVerifyPacket = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CandidateEvidence = {
  artifactRevisionSha256: string;
  evidenceSha256: string;
  revisionSha256: string;
  produced: string[];
  hashes: Record<string, string | null>;
  baselineHashes: Record<string, string | null>;
  verification: CritiqueVerifyPacket[];
  files: CritiqueFilePacket[];
  packetSha256: string;
  outputSha256: string;
  ownsPaths: string[];
  neverTouch: string[];
  truncated: boolean;
  truncateReason?: string;
};

export type FrozenCritiquePolicy = {
  enabled: boolean;
  mode: "advisory" | "gate";
  autoFix: boolean;
  maxRounds: number;
  agent: string;
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
};

export type FrozenDispatchContext = {
  memoryText: string;
  executionPacket: string;
  executionPacketSha256: string;
  pmReadContext: string;
  agent: string;
  helperMode: string;
  helperRequired: boolean;
};

export type WriterIdentity = {
  attemptId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier: "default" | "fast" | null;
  environmentId: string | null;
  workspacePath: string;
};

export type ReviewerIdentity = {
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  mode: "advisory" | "gate";
  maxRounds: number;
  autoFix: boolean;
};

export type CodeCritiqueLedger = {
  artifactRevisionSha256: string;
  evidenceSha256?: string;
  revisionSha256: string;
  findingsHash: string;
  repairRound: number;
  spawnAttempted: boolean;
  repairObserved?: boolean;
  repairThreadId?: string;
  writer?: WriterIdentity;
  reviewer?: ReviewerIdentity;
  findings?: CodeCritiqueFinding[];
  policy?: FrozenCritiquePolicy;
};

export type CodeCritiqueSettings = {
  enabled: boolean;
  mode: "advisory" | "gate";
  autoFix: boolean;
  maxRounds: number;
  agent: string;
};

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function settingOff(value: unknown): boolean {
  return value === false || value === 0
    || (typeof value === "string" && ["0", "off", "false", "no"].includes(value.trim().toLowerCase()));
}

export function parseCodeCritiqueSettings(settings: Record<string, unknown>): CodeCritiqueSettings {
  const maxRaw = settings["code_critique.max_rounds"];
  let maxRounds = 1;
  if (maxRaw !== undefined && maxRaw !== null && maxRaw !== "") {
    const parsed = typeof maxRaw === "string" && /^\d+$/.test(maxRaw) ? Number(maxRaw) : maxRaw;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > CODE_CRITIQUE_MAX_ROUNDS) {
      throw new Error("code_critique.max_rounds must be an integer 1-3");
    }
    maxRounds = parsed;
  }
  const auto = settings["code_critique.auto_fix"];
  const autoFix = auto === undefined || auto === null || auto === ""
    ? true
    : auto === true || auto === 1 || (typeof auto === "string" && ["1", "true", "on", "yes"].includes(auto.trim().toLowerCase()));
  if (!autoFix && auto !== false && auto !== 0 && !(typeof auto === "string" && ["0", "false", "off", "no"].includes(auto.trim().toLowerCase()))) {
    throw new Error("code_critique.auto_fix must be a boolean");
  }
  const enabledRaw = settings["code_critique.enabled"];
  const enabled = enabledRaw === true || enabledRaw === 1
    || (typeof enabledRaw === "string" && ["1", "true", "on", "yes"].includes(enabledRaw.trim().toLowerCase()));
  if (!enabled && enabledRaw !== undefined && enabledRaw !== null && enabledRaw !== ""
    && enabledRaw !== false && enabledRaw !== 0
    && !(typeof enabledRaw === "string" && ["0", "false", "off", "no"].includes(enabledRaw.trim().toLowerCase()))) {
    throw new Error("code_critique.enabled must be a boolean");
  }
  return {
    enabled,
    mode: settings["code_critique.mode"] === "advisory" ? "advisory" : "gate",
    autoFix,
    maxRounds,
    agent: typeof settings["code_critique.agent"] === "string" && settings["code_critique.agent"].trim()
      ? settings["code_critique.agent"].trim()
      : "code-critic",
  };
}

const MAX_CRITIQUE_PACKET_BYTES = 24 * 1024;
const MAX_FILE_EXCERPT_BYTES = 8 * 1024;
export const MAX_VERIFICATION_IO_BYTES = 4_000;

export function buildCandidateEvidence(input: {
  produced: string[];
  hashes: Record<string, string | null>;
  baselineHashes?: Record<string, string | null>;
  verification: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>;
  files?: Array<{ path: string; content: string | null }>;
  output: string;
  ownsPaths: string[];
  neverTouch: string[];
  dirtOk: boolean;
  dirtReason?: string;
}): CandidateEvidence {
  const missingHash = input.produced.filter((path) => !input.hashes[path]);
  const baselineHashes = input.baselineHashes ?? {};
  const filesByPath = new Map((input.files ?? []).map((row) => [row.path, row.content]));
  const missingContent = input.produced.filter((path) => typeof filesByPath.get(path) !== "string");
  const missingVerifyIo = input.verification.some((row) => typeof row.stdout !== "string" || typeof row.stderr !== "string");
  const hashMismatches: string[] = [];
  const files: CritiqueFilePacket[] = [];
  let packetBytes = 0;
  let packetOver = false;
  for (const path of [...input.produced].sort()) {
    const raw = filesByPath.get(path);
    if (typeof raw !== "string") continue;
    const captured = input.hashes[path];
    if (captured && sha256Text(raw) !== captured) hashMismatches.push(path);
    const excerptBytes = Buffer.from(raw, "utf8");
    const content = excerptBytes.byteLength > MAX_FILE_EXCERPT_BYTES
      ? excerptBytes.subarray(0, MAX_FILE_EXCERPT_BYTES).toString("utf8")
      : raw;
    if (excerptBytes.byteLength > MAX_FILE_EXCERPT_BYTES) packetOver = true;
    const header = Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
    if (packetBytes + header > MAX_CRITIQUE_PACKET_BYTES) { packetOver = true; break; }
    packetBytes += header;
    const current = input.hashes[path] ?? null;
    const baseline = baselineHashes[path] ?? null;
    files.push({
      path,
      sha256: current,
      baselineSha256: baseline,
      content,
      diff: baseline && current && baseline !== current
        ? `hash ${baseline} -> ${current}\n${content}`
        : `new ${current ?? "unknown"}\n${content}`,
    });
  }
  let verifyIoTruncated = false;
  const verification: CritiqueVerifyPacket[] = input.verification.map((row) => {
    const bound = (value: string | undefined) => {
      if (typeof value !== "string") return "";
      const bytes = Buffer.from(value, "utf8");
      if (bytes.byteLength > MAX_VERIFICATION_IO_BYTES) {
        verifyIoTruncated = true;
        return bytes.subarray(0, MAX_VERIFICATION_IO_BYTES).toString("utf8");
      }
      return value;
    };
    return {
      command: row.command,
      exitCode: row.exitCode,
      stdout: bound(row.stdout),
      stderr: bound(row.stderr),
    };
  });
  const outputSha256 = sha256Text(input.output);
  const packetSha256 = sha256Text(JSON.stringify({ files, verification }));
  const reasons: string[] = [];
  if (!input.dirtOk) reasons.push(input.dirtReason ?? "workspace_snapshot_unavailable");
  if (missingHash.length) reasons.push(`missing_hash:${missingHash.join(",")}`);
  if (missingContent.length) reasons.push(`missing_content:${missingContent.join(",")}`);
  if (missingVerifyIo) reasons.push("missing_verification_io");
  if (verifyIoTruncated) reasons.push("verification_io_truncated");
  if (hashMismatches.length) reasons.push(`content_hash_mismatch:${hashMismatches.join(",")}`);
  if (packetOver) reasons.push("packet_truncated");
  const truncated = reasons.length > 0;
  const artifactBody = {
    produced: [...input.produced].sort(),
    files: [...input.produced].sort().map((path) => ({
      path,
      contentSha256: input.hashes[path] ?? null,
      baselineSha256: baselineHashes[path] ?? null,
    })),
    ownsPaths: [...input.ownsPaths].sort(),
    neverTouch: [...input.neverTouch].sort(),
  };
  const artifactRevisionSha256 = sha256Text(JSON.stringify(artifactBody));
  const evidenceBody = {
    artifactRevisionSha256,
    outputSha256,
    packetSha256,
    verification: verification.map((row) => ({
      command: row.command, exitCode: row.exitCode,
      stdoutSha256: sha256Text(row.stdout), stderrSha256: sha256Text(row.stderr),
    })),
  };
  const evidenceSha256 = sha256Text(JSON.stringify(evidenceBody));
  return {
    artifactRevisionSha256,
    evidenceSha256,
    revisionSha256: artifactRevisionSha256,
    produced: artifactBody.produced,
    hashes: input.hashes,
    baselineHashes,
    verification,
    files,
    packetSha256,
    outputSha256,
    ownsPaths: artifactBody.ownsPaths,
    neverTouch: artifactBody.neverTouch,
    truncated,
    ...(truncated ? { truncateReason: reasons.join(";") } : {}),
  };
}

export function codeCritiqueSource(input: {
  evidence: CandidateEvidence;
  task: unknown;
  agent: string;
  disputes?: unknown;
}): string {
  return JSON.stringify({
    evidenceSha256: input.evidence.evidenceSha256,
    artifactRevisionSha256: input.evidence.artifactRevisionSha256,
    produced: input.evidence.produced,
    hashes: input.evidence.hashes,
    baselineHashes: input.evidence.baselineHashes,
    verification: input.evidence.verification,
    packetSha256: input.evidence.packetSha256,
    outputSha256: input.evidence.outputSha256,
    ownsPaths: input.evidence.ownsPaths,
    neverTouch: input.evidence.neverTouch,
    truncated: input.evidence.truncated,
    agent: input.agent,
    task: input.task,
    ...(input.disputes ? { disputes: input.disputes } : {}),
  });
}

export function codeCritiquePrompt(input: {
  evidence: CandidateEvidence;
  task: unknown;
  agent?: string;
  disputes?: unknown;
}): string {
  return [
    `You are ${input.agent?.trim() || "the independent code-critique stage"} for a bounded software task.`,
    "Review the completed writer candidate, not the writer's self-report. Do not execute tools or modify files.",
    "Judge only in-scope owns_paths against the task contract, host-read file bytes/diff, writer reply hash, and verification stdout/stderr. Exit codes alone are not sufficient.",
    "Return exactly one JSON object matching {decision:'approve'|'changes_requested',summary:string,findings:[{id,severity:'info'|'warning'|'blocking',finding,criterion,path?,line?,evidence?,impact?,trigger?,verificationExpectation?}]}",
    "Use a stable finding id. Use changes_requested only for concrete unmet requirements, ignored rules, uncovered changed behavior, or report/test/diff contradictions.",
    "Cosmetic preferences are severity info and must not be blocking. Ambiguous issues stay uncertain; do not invent rewrites.",
    "TASK CONTRACT:", JSON.stringify(input.task),
    "CANDIDATE EVIDENCE:", JSON.stringify({
      artifactRevisionSha256: input.evidence.artifactRevisionSha256,
      evidenceSha256: input.evidence.evidenceSha256,
      outputSha256: input.evidence.outputSha256,
      packetSha256: input.evidence.packetSha256,
      produced: input.evidence.produced,
      hashes: input.evidence.hashes,
      baselineHashes: input.evidence.baselineHashes,
      ownsPaths: input.evidence.ownsPaths,
      neverTouch: input.evidence.neverTouch,
    }),
    "HOST-READ PACKET (actual bytes; tools are forbidden):", JSON.stringify({ files: input.evidence.files, verification: input.evidence.verification }),
    ...(input.disputes ? ["WRITER DISPUTES (re-evaluate; do not treat as self-clear):", JSON.stringify(input.disputes)] : []),
  ].join("\n\n");
}

export function parseCodeCritique(output: string): CodeCritiqueResult {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return codeCritiqueResultSchema.parse(JSON.parse(trimmed));
}

export function actionableFindings(result: CodeCritiqueResult): CodeCritiqueFinding[] {
  return result.findings.filter((row) => row.severity === "blocking");
}

export function findingFingerprint(findings: readonly CodeCritiqueFinding[]): string {
  return sha256Text(JSON.stringify(findings.map((row) => row.id).sort()));
}

export function shouldRequestRepair(input: {
  settings: CodeCritiqueSettings;
  result: CodeCritiqueResult;
  round: number;
}): boolean {
  if (!input.settings.enabled || input.settings.mode !== "gate" || !input.settings.autoFix) return false;
  if (input.result.decision !== "changes_requested") return false;
  if (actionableFindings(input.result).length === 0) return false;
  return input.round < input.settings.maxRounds;
}

export const writerRepairReplySchema = z.object({
  replies: z.array(z.object({
    id: z.string().min(1).max(80),
    status: z.enum(["fixed", "disputed", "blocked"]),
    evidence: z.string().min(1).max(2000),
  }).strict()).max(30),
}).strict();

export type WriterRepairReply = z.infer<typeof writerRepairReplySchema>;

export function parseWriterRepairReply(output: string): WriterRepairReply | null {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = writerRepairReplySchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
  return parsed.success ? parsed.data : null;
}

export function codeRepairPrompt(input: {
  task: unknown;
  findings: CodeCritiqueFinding[];
  evidence: CandidateEvidence;
  agent?: string;
}): string {
  return [
    `You are ${input.agent?.trim() || "Lane Pilot writer"} repairing the same bounded task.`,
    "Stay inside the original owns_paths and never_touch. Do not widen scope or change requirements.",
    "For each finding reply with fixed + evidence, disputed + counterexample/test, or blocked.",
    "A dispute is not a self-clear. After edits or disputes, end with JSON {replies:[{id,status:'fixed'|'disputed'|'blocked',evidence}]}.",
    "TASK CONTRACT:", JSON.stringify(input.task),
    "CANDIDATE ARTIFACT:", input.evidence.artifactRevisionSha256,
    "FINDINGS:", JSON.stringify(input.findings),
  ].join("\n\n");
}

export function sameUnresolvedFindings(previous: readonly CodeCritiqueFinding[], next: readonly CodeCritiqueFinding[]): boolean {
  const left = new Set(actionableFindings({ decision: "changes_requested", summary: "x", findings: [...previous] }).map((row) => row.id));
  const right = actionableFindings({ decision: "changes_requested", summary: "x", findings: [...next] }).map((row) => row.id);
  return right.length > 0 && right.every((id) => left.has(id));
}

export function critiqueFromStageResult(result: unknown): CodeCritiqueResult | undefined {
  if (!result || typeof result !== "object") return undefined;
  const parsed = codeCritiqueResultSchema.safeParse({
    decision: (result as { decision?: unknown }).decision,
    summary: (result as { summary?: unknown }).summary,
    findings: (result as { findings?: unknown }).findings ?? [],
  });
  return parsed.success ? parsed.data : undefined;
}

export function findingsHash(findings: readonly CodeCritiqueFinding[]): string {
  return sha256Text(JSON.stringify(findings.map((row) => ({
    id: row.id, severity: row.severity, finding: row.finding, criterion: row.criterion, path: row.path ?? null,
  }))));
}

export function sameWriterIdentity(expected: WriterIdentity, actual: WriterIdentity): boolean {
  return expected.attemptId === actual.attemptId
    && expected.providerId === actual.providerId
    && expected.model === actual.model
    && expected.reasoningLevel === actual.reasoningLevel
    && expected.serviceTier === actual.serviceTier
    && expected.environmentId === actual.environmentId
    && expected.workspacePath === actual.workspacePath;
}

export function nextRepairAction(input: {
  ledger?: CodeCritiqueLedger;
  nextRound: number;
  attemptId?: string;
  artifactRevisionSha256?: string;
  revisionSha256?: string;
}): "spawn" | "wait" | "unknown" {
  const ledger = input.ledger;
  if (!ledger) return "spawn";
  const claimed = ledger.spawnAttempted && ledger.repairRound === input.nextRound;
  if (claimed) {
    if (input.attemptId && ledger.writer?.attemptId && ledger.writer.attemptId !== input.attemptId) return "unknown";
    if (!ledger.repairThreadId) return "unknown";
    if (ledger.repairObserved) return "spawn";
    return "wait";
  }
  return "spawn";
}

export function persistLedgerFields(result: unknown): Record<string, unknown> {
  const ledger = repairLedgerFromResult(result);
  if (!ledger) return {};
  return {
    repairRound: ledger.repairRound,
    spawnAttempted: ledger.spawnAttempted,
    ...(ledger.repairObserved ? { repairObserved: true } : {}),
    artifactRevisionSha256: ledger.artifactRevisionSha256,
    revisionSha256: ledger.revisionSha256,
    ...(ledger.evidenceSha256 ? { evidenceSha256: ledger.evidenceSha256 } : {}),
    ...(ledger.repairThreadId ? { repairThreadId: ledger.repairThreadId } : {}),
    ...(ledger.writer ? { writer: ledger.writer } : {}),
    ...(ledger.findingsHash ? { findingsHash: ledger.findingsHash } : {}),
  };
}

export function freezeCritiquePolicy(input: {
  settings: CodeCritiqueSettings;
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
}): FrozenCritiquePolicy {
  return {
    enabled: input.settings.enabled,
    mode: input.settings.mode,
    autoFix: input.settings.autoFix,
    maxRounds: input.settings.maxRounds,
    agent: input.settings.agent,
    providerId: input.providerId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
  };
}

export function settingsFromFrozenPolicy(policy: FrozenCritiquePolicy): CodeCritiqueSettings {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    autoFix: policy.autoFix,
    maxRounds: policy.maxRounds,
    agent: policy.agent,
  };
}

export function critiquePolicyFromResult(result: unknown): FrozenCritiquePolicy | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = (result as { policy?: unknown }).policy;
  if (!row || typeof row !== "object") return undefined;
  const policy = row as Record<string, unknown>;
  if (typeof policy.providerId !== "string" || typeof policy.model !== "string") return undefined;
  if (typeof policy.maxRounds !== "number" || !Number.isSafeInteger(policy.maxRounds)) return undefined;
  return {
    enabled: policy.enabled !== false,
    mode: policy.mode === "advisory" ? "advisory" : "gate",
    autoFix: policy.autoFix !== false,
    maxRounds: policy.maxRounds,
    agent: typeof policy.agent === "string" && policy.agent.trim() ? policy.agent.trim() : "code-critic",
    providerId: policy.providerId,
    model: policy.model,
    reasoningEffort: typeof policy.reasoningEffort === "string" ? policy.reasoningEffort : "medium",
    serviceTier: typeof policy.serviceTier === "string" ? policy.serviceTier : "standard",
  };
}

export function repairLedgerFromResult(result: unknown): CodeCritiqueLedger | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = result as Record<string, unknown>;
  if (typeof row.revisionSha256 !== "string" && typeof row.artifactRevisionSha256 !== "string") return undefined;
  const artifactRevisionSha256 = typeof row.artifactRevisionSha256 === "string" && row.artifactRevisionSha256
    ? row.artifactRevisionSha256
    : String(row.revisionSha256 ?? "");
  if (!artifactRevisionSha256) return undefined;
  const repairRound = typeof row.repairRound === "number" && Number.isSafeInteger(row.repairRound) ? row.repairRound : 0;
  const writer = row.writer && typeof row.writer === "object" ? row.writer as WriterIdentity : undefined;
  const reviewer = row.reviewer && typeof row.reviewer === "object" ? row.reviewer as ReviewerIdentity : undefined;
  const policy = critiquePolicyFromResult(result);
  return {
    artifactRevisionSha256,
    evidenceSha256: typeof row.evidenceSha256 === "string" ? row.evidenceSha256 : undefined,
    revisionSha256: artifactRevisionSha256,
    findingsHash: typeof row.findingsHash === "string" ? row.findingsHash : "",
    repairRound,
    spawnAttempted: row.spawnAttempted === true,
    ...(row.repairObserved === true ? { repairObserved: true } : {}),
    ...(typeof row.repairThreadId === "string" && row.repairThreadId ? { repairThreadId: row.repairThreadId } : {}),
    ...(writer ? { writer } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(Array.isArray(row.findings) ? { findings: row.findings as CodeCritiqueFinding[] } : {}),
    ...(policy ? { policy } : {}),
  };
}
