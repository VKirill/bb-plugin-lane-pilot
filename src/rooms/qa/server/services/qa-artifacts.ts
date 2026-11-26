import type { QaArtifactRef, QaExpect } from "../../models/qa-thread";

export type { QaArtifactClaim, QaArtifactRef } from "../../models/qa-thread";

/**
 * Screenshot evidence for a BB-thread browser check. The verdict JSON only claims paths; the host re-reads every
 * file inside the check thread's own storage root (threads.storageLocation), verifies the SDK-reported sha256/size
 * and PNG/JPEG signature bytes, and records refs the stage receipt can point at. Model-supplied hashes are never read.
 */

type ArtifactSdk = {
  threads: { storageLocation(args: { threadId: string }): Promise<{ hostId: string; storageRootPath: string }> };
  files: { read(args: { hostId: string; rootPath: string; path: string }): Promise<{
    content?: unknown; contentEncoding?: string; sha256?: string; sizeBytes?: number;
  }> };
};

const MAX_QA_ARTIFACTS = 100;
// The host file-read path refuses images above 10 MiB; the same bound is enforced for each claimed image.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const QA_ARTIFACT_PATH_RE = /^artifacts\/browser-qa\/c(\d+)-(\d+)\.(png|jpe?g)$/;
const QA_SHA256_RE = /^[0-9a-f]{64}$/i;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function artifactImageProblem(file: { content?: unknown; contentEncoding?: string; sha256?: string; sizeBytes?: number }, ext: string): string | null {
  if (file.contentEncoding !== "base64" || typeof file.content !== "string") return "artifact_not_binary";
  const sha256 = typeof file.sha256 === "string" ? file.sha256 : "";
  const size = typeof file.sizeBytes === "number" ? file.sizeBytes : -1;
  if (!QA_SHA256_RE.test(sha256) || !Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) return "artifact_metadata_invalid";
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length !== size) return "artifact_size_mismatch";
  const magic = ext === "png" ? PNG_MAGIC : JPEG_MAGIC;
  if (bytes.length < magic.length || !magic.every((byte, index) => bytes[index] === byte)) return "artifact_not_image";
  return null;
}

/**
 * Verifies the verdict's artifact claims against files in the thread's own storage. Every case×viewport the check
 * reports as passed or failed needs one verified ref; problems are named so a pass can be refused with a reason.
 */
export async function collectQaArtifacts(
  sdk: ArtifactSdk,
  threadId: string,
  expect: QaExpect,
  rows: ReadonlyArray<{ id?: string; viewport: string; result: string }>,
  claims: readonly unknown[],
): Promise<{ refs: QaArtifactRef[]; problems: string[] }> {
  const problems: string[] = [];
  const refs: QaArtifactRef[] = [];
  const byPair = new Map<string, QaArtifactRef>();
  const caseIds = new Set(expect.cases.map((item) => item.id));
  // A blocked pair may have no screenshot, so none is required.
  const required = new Set<string>();
  for (const row of rows) {
    if (row.result !== "passed" && row.result !== "failed") continue;
    if (!row.id) { problems.push(`evidence_row_unbound:${row.viewport}`); continue; }
    required.add(`${row.id}@${row.viewport}`);
  }
  if (claims.length > MAX_QA_ARTIFACTS) problems.push(`artifact_claims_exceeded:${claims.length}`);
  let location: { hostId: string; storageRootPath: string } | null = null;
  let locationFailed = false;
  const root = async () => {
    if (location || locationFailed) return location;
    try { location = await sdk.threads.storageLocation({ threadId }); }
    catch { locationFailed = true; problems.push("artifact_storage_unavailable"); }
    return location;
  };
  for (const raw of claims.slice(0, MAX_QA_ARTIFACTS)) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const idRaw = typeof item.case === "string" ? item.case.trim() : "";
    const idMatch = /^c(\d+)$/i.exec(idRaw);
    const caseId = idMatch ? `c${Number(idMatch[1])}` : null;
    const viewport = typeof item.viewport === "string" ? item.viewport.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!caseId || !caseIds.has(caseId)) { problems.push(`unknown_claim_case:${idRaw.slice(0, 40) || "?"}`); continue; }
    if (!expect.viewports.includes(viewport)) { problems.push(`unknown_claim_viewport:${caseId}:${viewport.slice(0, 24) || "?"}`); continue; }
    const name = QA_ARTIFACT_PATH_RE.exec(path);
    if (!name || `c${Number(name[1])}` !== caseId || name[2] !== viewport) { problems.push(`artifact_path_invalid:${caseId}@${viewport}`); continue; }
    const key = `${caseId}@${viewport}`;
    if (byPair.has(key)) { problems.push(`duplicate_claim:${key}`); continue; }
    const loc = await root();
    if (!loc) { problems.push(`artifact_unreadable:${key}`); continue; }
    const abs = `${loc.storageRootPath.replace(/\/+$/, "")}/${path}`;
    let file: { content?: unknown; contentEncoding?: string; sha256?: string; sizeBytes?: number };
    try { file = await sdk.files.read({ hostId: loc.hostId, rootPath: loc.storageRootPath, path: abs }); }
    catch { problems.push(`artifact_unreadable:${key}`); continue; }
    const imageProblem = artifactImageProblem(file, name[3]!);
    if (imageProblem) { problems.push(`${imageProblem}:${key}`); continue; }
    // The receipt keeps the absolute read target: hostId + this path opens the verified bytes anywhere.
    const ref: QaArtifactRef = { case: caseId, viewport, hostId: loc.hostId, path: abs, sha256: file.sha256!.toLowerCase(), size: file.sizeBytes! };
    byPair.set(key, ref);
    refs.push(ref);
  }
  for (const key of required) if (!byPair.has(key)) problems.push(`missing_evidence:${key}`);
  return { refs: refs.slice(0, MAX_QA_ARTIFACTS), problems };
}
