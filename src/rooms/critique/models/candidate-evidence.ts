import { sha256Hex, stripAnsi } from "@lane-pilot/kit";

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
  /** Root the produced paths resolve against — the workspace the critic itself runs in and can `git diff` and read. */
  workspace?: string;
  /** Frozen base commit the produced diffs are measured against; committed work has no HEAD diff, so the critic's own `git diff` uses this instead of HEAD. */
  diffBase?: string;
  /** Absolute paths of produced files the packet could not carry; the critic reads them itself (W33). */
  unreadPaths?: string[];
  /** Absolute paths of produced files whose read threw (EACCES, a host 500): unknown, never a silent pass. */
  unreadablePaths?: string[];
  /** Tests that existed before the task and that the writer changed: the critic runs for them whatever the risk (withReferenceTestCritic). */
  referenceTestEdits?: string[];
};

// The packet carries each file's change as a unified diff from BB (bb--git keyed patches) and the whole file only when it is small:
// a 30-line edit in a 40 KB file used to cut the file to its first 8 KB and block every gated task (selfystudio, 2026-10-29: 13 of
// 14 code critiques that week ended code_critique_evidence_unknown:packet_truncated).
const MAX_CRITIQUE_PACKET_BYTES = 96 * 1024;
export const MAX_FILE_EXCERPT_BYTES = 8 * 1024;
export const MAX_VERIFICATION_IO_BYTES = 4_000;
/** Of a long command output the critic sees the head and the tail (errors come last); the cut is said, it does not block. */
const VERIFICATION_IO_HEAD_BYTES = 1_000;
export const NEW_FILE_DIFF = "new file: the whole file is in content";
/** A unified diff git produced — not the `new <hash>`/`hash a -> b` no-patch fallbacks and not the new-file marker. */
export const realPatch = (diff: string) => !diff.startsWith("new ") && !diff.startsWith("hash ");
/** A git diff that creates the file (`new file mode`, `--- /dev/null`). */
export const gitNewFile = (diff: string) => /^(?:new file mode|--- \/dev\/null)/m.test(diff);
const plainOutput = (text: string) => stripAnsi(text).replace(/\r\n/g, "\n").split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1)).join("\n").replace(/\n{3,}/g, "\n\n");

export function buildCandidateEvidence(input: {
  produced: string[];
  hashes: Record<string, string | null>;
  baselineHashes?: Record<string, string | null>;
  verification: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>;
  files?: Array<{ path: string; content: string | null | undefined }>;
  /** Unified diff per produced path (BB bb--git patches, uncommitted); a path without one is shown as its whole file. */
  patches?: Record<string, string>;
  output: string;
  ownsPaths: string[];
  neverTouch: string[];
  dirtOk: boolean;
  dirtReason?: string;
  /** Frozen base commit for the critic's own `git diff` when the change is committed (see CandidateEvidence.diffBase). */
  diffBase?: string;
  /** Root that relative produced paths resolve against, for the unreadPaths the critic reads itself. */
  workspace?: string;
  referenceTestEdits?: string[];
}): CandidateEvidence {
  const missingHash = input.produced.filter((path) => !input.hashes[path]);
  const baselineHashes = input.baselineHashes ?? {};
  const filesByPath = new Map((input.files ?? []).map((row) => [row.path, row.content]));
  const missingContent = input.produced.filter((path) => typeof filesByPath.get(path) !== "string");
  const missingVerifyIo = input.verification.some((row) => typeof row.stdout !== "string" || typeof row.stderr !== "string");
  const hashMismatches: string[] = [];
  const files: CritiqueFilePacket[] = [];
  const unreadPaths: string[] = [];
  let packetBytes = 0;
  let packetOver = false;
  const absolute = (path: string) => (path.startsWith("/") || !input.workspace ? path : `${input.workspace.replace(/\/+$/, "")}/${path}`);
  const unreadablePaths = (input.files ?? []).filter((row) => row.content === undefined).map((row) => absolute(row.path));
  for (const path of [...input.produced].sort()) {
    const raw = filesByPath.get(path);
    if (typeof raw !== "string") continue;
    const captured = input.hashes[path];
    if (captured && sha256Hex(raw) !== captured) hashMismatches.push(path);
    const patch = input.patches?.[path];
    const small = Buffer.byteLength(raw, "utf8") <= MAX_FILE_EXCERPT_BYTES;
    // A large file without a diff cannot be shown whole: that alone is unknown evidence. With its diff the change is complete.
    if (!small && typeof patch !== "string") { packetOver = true; unreadPaths.push(absolute(path)); }
    const content = small ? raw : typeof patch === "string" ? "" : Buffer.from(raw, "utf8").subarray(0, MAX_FILE_EXCERPT_BYTES).toString("utf8");
    const current = input.hashes[path] ?? null;
    const baseline = baselineHashes[path] ?? null;
    // A new small file's patch is the whole file again with `+` in front: the content carries it, the diff only says it is new.
    const newWhole = small && typeof patch === "string" && gitNewFile(patch);
    const diff = newWhole ? NEW_FILE_DIFF : typeof patch === "string"
      ? patch
      : baseline && current && baseline !== current ? `hash ${baseline} -> ${current}\n${content}` : `new ${current ?? "unknown"}\n${content}`;
    const header = Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8") + Buffer.byteLength(diff, "utf8");
    if (packetBytes + header > MAX_CRITIQUE_PACKET_BYTES) { packetOver = true; unreadPaths.push(absolute(path)); continue; }
    packetBytes += header;
    files.push({ path, sha256: current, baselineSha256: baseline, content, diff });
  }
  // A file the attempt created is no reference test: in a folder without a worktree the «before» is read from the folder the writer just
  // wrote into, and a new test was shown to the critic as one that «existed before this task» (photoalive 2026-11-10).
  const created = new Set(files.filter((file) => file.diff === NEW_FILE_DIFF || gitNewFile(file.diff)).map((file) => file.path));
  const reference = (input.referenceTestEdits ?? []).filter((path) => !created.has(path));
  const verification: CritiqueVerifyPacket[] = input.verification.map((row) => {
    // Lane Pilot ran these commands itself and holds their exit codes; a long output (a lint with 247 warnings) is cut to its head
    // and tail with the cut said, and is no longer unknown evidence (2026-10-29).
    const bound = (value: string | undefined) => {
      if (typeof value !== "string") return "";
      // Colour codes and progress redraws (vitest under a TTY) are half of a test run's output and say nothing to the critic.
      const plain = plainOutput(value);
      const bytes = Buffer.from(plain, "utf8");
      if (bytes.byteLength <= MAX_VERIFICATION_IO_BYTES) return plain;
      const tail = MAX_VERIFICATION_IO_BYTES - VERIFICATION_IO_HEAD_BYTES;
      return `${bytes.subarray(0, VERIFICATION_IO_HEAD_BYTES).toString("utf8")}\n[… ${bytes.byteLength - MAX_VERIFICATION_IO_BYTES} bytes cut by Lane Pilot …]\n${bytes.subarray(bytes.byteLength - tail).toString("utf8")}`;
    };
    return {
      command: row.command,
      exitCode: row.exitCode,
      stdout: bound(row.stdout),
      stderr: bound(row.stderr),
    };
  });
  const outputSha256 = sha256Hex(input.output);
  const packetSha256 = sha256Hex(JSON.stringify({ files, verification }));
  const reasons: string[] = [];
  if (!input.dirtOk) reasons.push(input.dirtReason ?? "workspace_snapshot_unavailable");
  if (missingHash.length) reasons.push(`missing_hash:${missingHash.join(",")}`);
  if (missingContent.length) reasons.push(`missing_content:${missingContent.join(",")}`);
  if (missingVerifyIo) reasons.push("missing_verification_io");
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
  const artifactRevisionSha256 = sha256Hex(JSON.stringify(artifactBody));
  const evidenceBody = {
    artifactRevisionSha256,
    outputSha256,
    packetSha256,
    verification: verification.map((row) => ({
      command: row.command, exitCode: row.exitCode,
      stdoutSha256: sha256Hex(row.stdout), stderrSha256: sha256Hex(row.stderr),
    })),
  };
  const evidenceSha256 = sha256Hex(JSON.stringify(evidenceBody));
  return {
    ...(reference.length ? { referenceTestEdits: reference } : {}),
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
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.diffBase ? { diffBase: input.diffBase } : {}),
    truncated,
    ...(truncated ? { truncateReason: reasons.join(";") } : {}),
    ...(unreadPaths.length ? { unreadPaths } : {}),
    ...(unreadablePaths.length ? { unreadablePaths } : {}),
  };
}
