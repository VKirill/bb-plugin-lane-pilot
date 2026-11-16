import { createJournal, readRootObservations, wfChildRuns } from "@lane-pilot/workflow-engine";
import type { StepRow } from "@lane-pilot/workflow-engine";
import { maskCredentials, parseJsonOr, sha256Hex, withoutSelectionMarkers } from "@lane-pilot/kit";
import { listRunFiles, runHomeOf } from "../../storage";
import type { ServerCore } from "../../contracts/server";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Compact repeated status lists for the audit; the caller retains complete windows in a bound reference. */
export function compactRepositoryEvidence(repository: readonly unknown[]) {
  const paths = (value: unknown): string[] | null => Array.isArray(value) && value.every((path) => typeof path === "string") ? value : null;
  const point = (value: unknown) => {
    const snapshot = record(value), files = paths(snapshot.files);
    return files ? { ...snapshot, files: { count: files.length, sha256: sha256Hex(JSON.stringify(files)) } } : value;
  };
  return repository.map((value, detailIndex) => {
    const entry = record(value), window = record(entry.window);
    const first = record(window.before), last = record(window.after);
    const before = paths(first.files), after = paths(last.files);
    const sameCheckout = typeof first.hostId === "string" && typeof first.root === "string" && first.hostId === last.hostId && first.root === last.root;
    const delta = before && after && sameCheckout ? (() => {
      const old = new Set(before), current = new Set(after);
      const added = after.filter((path) => !old.has(path)), removed = before.filter((path) => !current.has(path));
      return { added: added.slice(0, 80), removed: removed.slice(0, 80), omittedAdded: Math.max(0, added.length - 80), omittedRemoved: Math.max(0, removed.length - 80),
        scope: "Porcelain filename differences only; not byte changes or causal attribution." };
    })() : null;
    return { ...entry, detailIndex, window: { ...window, before: point(window.before), after: point(window.after) }, filenameDelta: delta };
  });
}

/** Engine receipts, not model assertions. Bounds remain explicit gaps in the audit evidence. */
export async function workflowAuditEvidence(ctx: ServerCore, runId: string, rootSteps: readonly StepRow[]) {
  const journal = createJournal(ctx.db);
  const queue = [runId], seen = new Set<string>(), repository: unknown[] = [], files: unknown[] = [];
  const omissions: string[] = [];
  const observed = readRootObservations(ctx.db, runId);
  const first = record(observed.before?.detail), last = record(observed.after?.detail);
  const before = record(first.snapshot), after = record(last.snapshot);
  const sameCheckout = typeof before.hostId === "string" && typeof before.root === "string" && before.hostId === after.hostId && before.root === after.root;
  const equal = (key: string): boolean | null => sameCheckout && typeof before[key] === "string" && typeof after[key] === "string" ? before[key] === after[key] : null;
  repository.push({ runId, role: "root", revision: observed.revision,
    beforeEvent: observed.before ? { seq: observed.before.seq, at: observed.before.at, reason: first.reason ?? null } : null,
    afterEvent: observed.after ? { seq: observed.after.seq, at: observed.after.at, reason: last.reason ?? null } : null,
    window: { before: first.snapshot ?? null, after: last.snapshot ?? null, checkoutBinding: sameCheckout ? "verified" : "unverified" },
    endpointComparison: { sameHead: equal("head"), sameWorkDiff: equal("workDiffHash"), sameIndexDiff: equal("indexDiffHash") },
    scope: "Initial root observation through current post-execution/pre-audit observation, including idle time and other checkout users. No causal attribution. Registered outputs below are not an exhaustive effects inventory." });
  if (!first.snapshot) omissions.push(`root initial observation unavailable${typeof first.reason === "string" ? `: ${first.reason}` : ""}`);
  if (!last.snapshot) omissions.push(`root final observation unavailable for execution revision ${observed.revision}${typeof last.reason === "string" ? `: ${last.reason}` : ""}`);
  if (first.snapshot && last.snapshot && !sameCheckout) omissions.push("root endpoints belong to different or unknown host/checkouts; no comparison is verified");
  while (queue.length && seen.size < 200) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const steps = id === runId ? rootSteps : journal.steps(id);
    for (const step of steps) {
      const receipt = record(parseJsonOr(step.receipt_json ?? "null", null));
      const detail = record(receipt.detail);
      const windows = [detail.repoGuard, ...(Array.isArray(detail.votes) ? detail.votes.map((vote) => record(record(vote).detail).repoGuard) : [])].filter((window) => window !== undefined);
      for (const window of windows) repository.push({ runId: id, step: step.step_key, state: step.state, window });
    }
    queue.push(...wfChildRuns(ctx.db, id).map((child) => child.id));
    // Root result files are the deliverables the final graph actually exposed; do not crawl arbitrary model paths.
    if (id !== runId) continue;
    const home = runHomeOf(ctx.db, id);
    const outputs = listRunFiles(ctx.db, id).filter((file) => file.kind === "output");
    if (outputs.length > 40) omissions.push(`${outputs.length - 40} root output files omitted (limit 40)`);
    for (const file of outputs.slice(0, 40)) {
      const base = { runId: id, path: file.repo_path, sha256: file.sha256, bytes: file.bytes, recordedAt: file.created_at };
      const producer = record(parseJsonOr(file.producer_json, null));
      const step = steps.find((entry) => entry.step_key === producer.wf_step_key && entry.node_id === file.node_id && entry.state === "succeeded");
      if (!home || file.root !== "checkout" || producer.run_id !== id || producer.node !== file.node_id || !step ||
          /^(?:\/|[A-Za-z]:)|\\|\0/.test(file.repo_path) || file.repo_path.split("/").some((part) => !part || part === ".." || part === ".")) {
        files.push({ ...base, verified: false, problem: "producer or checkout binding unavailable" }); continue;
      }
      if (file.bytes > 1_000_000) { files.push({ ...base, verified: false, problem: "file exceeds 1000000-byte audit limit" }); continue; }
      const path = `${home.base_path}/${file.repo_path}`;
      try {
        const read = await ctx.bb.sdk.files.read({ hostId: home.host_id, rootPath: home.base_path, path });
        if (read.contentEncoding !== "utf8" || typeof read.content !== "string" || sha256Hex(read.content) !== file.sha256 || Buffer.byteLength(read.content, "utf8") !== file.bytes) {
          files.push({ ...base, verified: false, problem: "current bytes do not match recorded output" }); continue;
        }
        const masked = maskCredentials(withoutSelectionMarkers(read.content));
        files.push({ ...base, hostId: home.host_id, rootPath: home.base_path, path, verified: true, content: masked.text,
          contentNote: "Read back now against the engine-recorded hash; credentials and selection markers removed from the supplied text. Not proof of historical immutability." });
      } catch { files.push({ ...base, verified: false, problem: "recorded output unreadable" }); }
    }
  }
  if (queue.length) omissions.push("descendant run limit 200 reached; repository windows incomplete");
  return { files, repository, omissions,
    scope: "Repository windows include root execution endpoints and measured helper endpoints, including votes. They do not prove absence of temporary write-and-revert, ignored/untracked-content changes, or external effects. Missing windows and null fingerprints are unverified; step success alone is not a no-change receipt. Registered output writes are hash-verified at readback, not an exhaustive account of checkout effects." };
}
