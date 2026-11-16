import { createJournal, wfChildRuns } from "@lane-pilot/workflow-engine";
import type { StepRow } from "@lane-pilot/workflow-engine";
import { maskCredentials, parseJsonOr, sha256Hex, withoutSelectionMarkers } from "@lane-pilot/kit";
import { listRunFiles, runHomeOf } from "../../storage";
import type { ServerCore } from "../../contracts/server";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Engine receipts, not model assertions. Bounds remain explicit gaps in the audit evidence. */
export async function workflowAuditEvidence(ctx: ServerCore, runId: string, rootSteps: readonly StepRow[]) {
  const journal = createJournal(ctx.db);
  const queue = [runId], seen = new Set<string>(), repository: unknown[] = [], files: unknown[] = [];
  const omissions: string[] = [];
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
    scope: "Repository windows are measured helper endpoints, including votes. They do not prove absence of temporary write-and-revert, ignored/untracked-content changes, or external effects. Missing windows are unverified; step success alone is not a no-change receipt." };
}
