import { jev } from "@lane-pilot/jev";
import { GUARD_BLOCKED_KEY, type GuardBlock } from "@lane-pilot/jev";
import { englishSelfRepairChoice, ownerLocale, selfRepairOwnerForm, type OwnerAnswer, type OwnerAsk } from "../../relay/server";
import type { VerdictStatus } from "../../critique";
import type { ServerCore } from "../../contracts/server";
import { reasonSignature } from "./episodes";
import { VERDICTS, type SelfRepairState, type SignatureRecord, type Verdict } from "./types";

/** Maps the owner's form choice onto the English option the repair thread reads. */
export function repairAnswerForThread(answer: OwnerAnswer): OwnerAnswer {
  if (answer.outcome !== "answered" || !answer.choice) return answer;
  const label = englishSelfRepairChoice(answer.choice.id);
  if (!label) return answer;
  const choice = { id: answer.choice.id, label };
  return { ...answer, choice, line: [label, answer.text].filter(Boolean).join(" — ") };
}

/** The repair thread's verdict as the unified status: fixed or already-fixed is a pass, not-lane-pilot a rework (the PM changes something), needs-owner a block. */
export function repairStatus(verdict: Verdict | null | undefined): VerdictStatus | null {
  return verdict === "fixed" || verdict === "already-fixed" ? "pass" : verdict === "not-lane-pilot" ? "rework" : verdict === "needs-owner" ? "block" : null;
}

export function parseVerdict(text: string): Verdict | null {
  const match = /SELF-REPAIR-VERDICT:\s*([a-z-]+)/i.exec(text);
  const value = match?.[1]?.toLowerCase();
  return VERDICTS.find((item) => item === value) ?? null;
}

export type VerdictEnv = {
  bb: ServerCore["bb"];
  log: (message: string) => void;
  patchRecord: (signature: string, change: (record: SignatureRecord, current: SelfRepairState) => void) => Promise<SignatureRecord | null>;
  ownerAsk?: OwnerAsk;
};

/**
 * The repair verdict is the stronger judge the Jev receipts waited for: a `guard:` incident confirms or denies the output
 * guard's block (fixed/already-fixed → agree, not-lane-pilot → a false positive), a merge suggestion's target says the
 * shared cause was real (agree), and a signature that needed its own repair proves its merge suggestion wrong (disagree).
 */
export async function labelJevReceipts(env: VerdictEnv, signature: string, verdict: Verdict, current: SelfRepairState): Promise<void> {
  const instance = jev();
  if (!instance) return;
  const positive = verdict === "fixed" || verdict === "already-fixed";
  const own = current.mergeSuggestions[signature];
  if (own) { instance.outcome(own.receiptId, "disagree"); delete current.mergeSuggestions[signature]; }
  for (const [sig, s] of Object.entries(current.mergeSuggestions)) {
    if (s.group !== signature) continue;
    if (positive) instance.outcome(s.receiptId, "agree");
    delete current.mergeSuggestions[sig];
  }
  if (!signature.startsWith("guard:")) return;
  const blocks = await env.bb.storage.kv.get(GUARD_BLOCKED_KEY).catch(() => null);
  for (const row of (Array.isArray(blocks) ? blocks : []) as GuardBlock[]) {
    if (row.receiptId == null || reasonSignature("guard", `${row.kind} output withheld by the output guard: ${row.reason}`) !== signature) continue;
    const label = positive ? "agree" : verdict === "not-lane-pilot" ? "disagree" : null;
    if (label) instance.outcome(row.receiptId, label);
  }
}

/**
 * A repair that ended «needs-owner» put its question in its report, where nobody looks. The owner is asked in the repair
 * thread as a form (a push on the phone) with the report's closing lines; the answer goes back into that thread as a
 * message. The repair's worktree is released as for any verdict but «fixed», so the answer is a decision to act on in a
 * new repair, not a continuation of the old edits. An older BB without question forms leaves the report as it was.
 */
export async function askOwnerAboutRepair(env: VerdictEnv, threadId: string, signature: string, report: string): Promise<boolean> {
  const title = signature.split(":").slice(2).join(":").slice(0, 100);
  const body = report.replace(/SELF-REPAIR-VERDICT:.*$/im, "").trim();
  const form = selfRepairOwnerForm(await ownerLocale(env.bb), title);
  const englishQuestion = selfRepairOwnerForm("en", title).question;
  const TIMEOUT_MS = 60 * 60_000;
  const settled = async (answer: OwnerAnswer) => {
    // Silence, a dismissal or «leave as is» sends nothing: the thread has no work to do, and the next pass releases its worktree.
    // (A message into it once its worktree was gone failed: «Provider codex failed to start: spawn /usr/bin/node ENOENT».)
    const goAhead = answer.outcome === "answered" && answer.choice?.id !== "2";
    if (goAhead) await env.ownerAsk!.sendToThread(threadId, env.ownerAsk!.answerMessage(englishQuestion, repairAnswerForThread(answer), TIMEOUT_MS));
    await env.patchRecord(signature, (stored) => {
      stored.ownerWaitUntil = null;
      // The thread works again: its next closing line is the verdict, read once it is idle.
      if (goAhead) { stored.verdict = null; stored.spawnedAt = Date.now(); stored.continuedAt = Date.now(); }
    });
    env.log(`self-repair: the owner's answer on @thread:${threadId}: ${goAhead ? "go ahead, the repair continues" : "no go-ahead, its worktree is released"}`);
  };
  const opened = await env.ownerAsk?.askInBackground(threadId, { source: "repair", question: form.question, detail: body.slice(-3000), options: form.options },
    settled, { timeoutMs: TIMEOUT_MS }).catch(() => false) ?? false;
  if (opened) env.log(`self-repair: asked the owner about @thread:${threadId} (needs-owner)`);
  return opened;
}

export async function readVerdict(env: VerdictEnv, signature: string, record: SignatureRecord, dryRun: boolean, current?: SelfRepairState): Promise<void> {
  const threadId = record.threadId!;
  const report = await Promise.resolve().then(() => env.bb.sdk.threads.output({ threadId }))
    .then((result) => { const value = (result as { output?: unknown; text?: unknown }).output ?? (result as { text?: unknown }).text; return typeof value === "string" ? value.slice(-4000) : ""; })
    .catch(() => "");
  record.verdict = parseVerdict(report);
  if (record.verdict && !dryRun && current) await labelJevReceipts(env, signature, record.verdict, current).catch(() => undefined);
  if (record.verdict === "needs-owner" && !dryRun) {
    // A graph step stores the verdict first: a step run again after a reload must not ask the owner twice.
    if (record.runId) await env.patchRecord(signature, (stored) => { stored.verdict = record.verdict; });
    // The worktree waits for the answer (60 min form + a margin); unopened, it is released as before.
    record.ownerWaitUntil = await askOwnerAboutRepair(env, threadId, signature, report) ? Date.now() + 65 * 60_000 : null;
    if (record.runId) await env.patchRecord(signature, (stored) => { stored.ownerWaitUntil = record.ownerWaitUntil; });
  }
}
