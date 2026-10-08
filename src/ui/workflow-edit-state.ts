import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../contracts";
import type { DraftOp } from "../workflow/draft";
import type { DraftDoc } from "./workflow-drafts";
import type { ModelError } from "./workflow-edit-model";

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;
export type TestRun = Output<"workflow_draft_test">;
export type PublishResult = Output<"workflow_draft_publish">;
export type Failure = ModelError | string;

type Call = (method: string, input: unknown) => Promise<unknown>;

const usesEdgeIndex = (ops: readonly DraftOp[]) => ops.some((op) => (op.op === "update_edge" || op.op === "remove_edge") && op.edge.index !== undefined);

/**
 * The editing of one draft: every change is a patch the server validates, saved as a new version. Patches go one at a time (each
 * with the version it is made on), so two quick edits cannot overwrite each other; a patch refused because the architect changed the
 * draft meanwhile is read again and, when it names its target by id, sent once more. Undo and redo restore earlier versions as new
 * ones, and only for the owner's own edits: a version somebody else made (the architect) clears them, so an undo never throws that away.
 */
export function useDraftEditing(doc: DraftDoc, read: () => Promise<unknown>) {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const draftId = doc.draftId;
  const version = useRef(doc.version ?? 1);
  const own = useRef(new Set<number>());
  const stacks = useRef<{ undo: number[]; redo: number[] }>({ undo: [], redo: [] });
  const [counts, setCounts] = useState({ undo: 0, redo: 0 });
  const [pending, setPending] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const readRef = useRef(read);
  readRef.current = read;

  const sync = () => setCounts({ undo: stacks.current.undo.length, redo: stacks.current.redo.length });

  // A version the owner did not make clears undo and redo; the draft is shown as it is.
  useEffect(() => {
    const current = doc.version ?? 1;
    if (current !== version.current && !own.current.has(current)) { stacks.current = { undo: [], redo: [] }; sync(); }
    version.current = current;
  }, [doc.version]);

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    setPending((count) => count + 1);
    const run = chain.current.then(job, job).finally(() => setPending((count) => count - 1));
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  const apply = useCallback((ops: DraftOp[]): Promise<{ ok: boolean; version?: number; refused?: string }> => enqueue(async () => {
    setFailure(null);
    for (let attempt = 0; ; attempt += 1) {
      let result: Output<"workflow_draft_patch">;
      try { result = await rpc.call("workflow_draft_patch", { draftId, ops, expectedVersion: version.current }) as Output<"workflow_draft_patch">; }
      catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); return { ok: false }; }
      if (result.applied) {
        stacks.current.undo.push(version.current);
        stacks.current.redo = [];
        version.current = result.version ?? version.current + 1;
        own.current.add(version.current);
        sync();
        setPublished(null);
        await readRef.current();
        return { ok: true, version: version.current };
      }
      if (result.reason === "version_conflict" && result.currentVersion !== undefined) {
        version.current = result.currentVersion;
        await readRef.current();
        if (attempt === 0 && !usesEdgeIndex(ops)) continue;
        setFailure({ key: "wfEditErr_conflict" });
        return { ok: false };
      }
      const reason = result.refused?.map((item) => item.reason).join("; ") ?? "refused";
      setFailure(reason);
      return { ok: false, refused: reason };
    }
  }), [draftId, enqueue, rpc]);

  const restore = useCallback((target: number, kind: "undo" | "redo" | "restore" = "restore") => enqueue(async () => {
    setFailure(null);
    try {
      const result = await rpc.call("workflow_draft_restore", { draftId, version: target, expectedVersion: version.current }) as Output<"workflow_draft_restore">;
      if (!result.ok) { await readRef.current(); setFailure(result.reason === "version_conflict" ? { key: "wfEditErr_conflict" } : result.reason ?? "refused"); return false; }
      const before = version.current;
      version.current = result.version ?? before + 1;
      own.current.add(version.current);
      if (kind === "undo") stacks.current.redo.push(before);
      else if (kind === "redo") stacks.current.undo.push(before);
      else { stacks.current.undo.push(before); stacks.current.redo = []; }
      sync();
      setPublished(null);
      await readRef.current();
      return true;
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); return false; }
  }), [draftId, enqueue, rpc]);

  const undo = useCallback(() => { const target = stacks.current.undo.pop(); sync(); return target === undefined ? Promise.resolve(false) : restore(target, "undo").then((ok) => { if (!ok) { stacks.current.undo.push(target); sync(); } return ok; }); }, [restore]);
  const redo = useCallback(() => { const target = stacks.current.redo.pop(); sync(); return target === undefined ? Promise.resolve(false) : restore(target, "redo").then((ok) => { if (!ok) { stacks.current.redo.push(target); sync(); } return ok; }); }, [restore]);

  const test = useCallback(async () => {
    setTesting(true); setFailure(null);
    try { setTestRun(await rpc.call("workflow_draft_test", { draftId }) as TestRun); await readRef.current(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTesting(false); }
  }, [draftId, rpc]);

  const publish = useCallback(async () => {
    setPublishing(true); setFailure(null);
    try { setPublished(await rpc.call("workflow_draft_publish", { draftId }) as PublishResult); await readRef.current(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPublishing(false); }
  }, [draftId, rpc]);

  return { apply, undo, redo, restore, test, publish, busy: pending > 0, failure, setFailure, canUndo: counts.undo > 0, canRedo: counts.redo > 0, testRun, testing, published, publishing, version: doc.version ?? 1, projectId: doc.projectId };
}

export type DraftEditing = ReturnType<typeof useDraftEditing>;

/** What the panels may offer: the names of what exists on the owner's machines, and the other workflows a node may call. */
export type Catalog = {
  loaded: boolean;
  skills: Array<{ value: string; label?: string }>; plugins: Array<{ value: string; label?: string }>; mcpServers: string[];
  secrets: Array<{ value: string; label?: string }>; hosts: Array<{ value: string; label: string; connected: boolean }>; specialists: string[];
  workflows: Array<{ value: string; label: string }>;
};
const EMPTY: Catalog = { loaded: false, skills: [], plugins: [], mcpServers: [], secrets: [], hosts: [], specialists: [], workflows: [] };

const items = (section: unknown): Array<Record<string, unknown>> => {
  const list = typeof section === "object" && section !== null ? (section as { items?: unknown }).items : null;
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
};

/** Read once when editing starts; a source that cannot be asked leaves its list empty and the controls take typed names instead. */
export function useCatalog(projectId: string | null, draftId: string, active: boolean): Catalog {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [catalog, setCatalog] = useState<Catalog>(EMPTY);
  useEffect(() => {
    if (!active || !projectId) return;
    let live = true;
    void (async () => {
      const [capabilities, listing] = await Promise.all([
        rpc.call("workflow_capabilities", { projectId, draftId }).catch(() => null) as Promise<{ capabilities?: Record<string, unknown> } | null>,
        rpc.call("workflow_list", { projectId }).catch(() => null) as Promise<Output<"workflow_list"> | null>,
      ]);
      if (!live) return;
      const caps = capabilities?.capabilities ?? {};
      const named = (section: string, key: string) => items(caps[section]).flatMap((item) => (typeof item[key] === "string" ? [{ value: item[key] as string, ...(typeof item.name === "string" && item.name !== item[key] ? { label: item.name } : {}) }] : []));
      setCatalog({
        loaded: Boolean(capabilities),
        skills: named("skills", "name"), plugins: named("plugins", "id"), mcpServers: items(caps.mcpServers).flatMap((item) => (typeof item.name === "string" ? [item.name] : [])),
        secrets: named("secrets", "name"),
        hosts: items(caps.hosts).flatMap((item) => (typeof item.id === "string" ? [{ value: item.id, label: typeof item.name === "string" ? item.name : item.id, connected: item.connected === true }] : [])),
        specialists: Array.isArray((caps.specialists as { roles?: unknown } | undefined)?.roles) ? ((caps.specialists as { roles: unknown[] }).roles.filter((role): role is string => typeof role === "string")) : [],
        workflows: (listing?.workflows ?? []).map((row) => ({ value: row.id, label: `${row.name.en} (${row.id})` })),
      });
    })();
    return () => { live = false; };
  }, [active, projectId, draftId, rpc]);
  return catalog;
}
