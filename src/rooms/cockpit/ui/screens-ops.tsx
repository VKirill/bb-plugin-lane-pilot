import { useState } from "react";
import { t } from "@lane-pilot/i18n";
import { Badge, Button } from "@lane-pilot/ui-kit";
import { Field, Loaded, Panel, RefreshButton, day, fill, useLoad, type Rpc } from "./kit";
import { COCKPIT_READS, SCREENS, unusedReads } from "./registry";

type Helper = { source: string; name: string; description: string; format: string };

/** Forge: the order a person places, and bring-your-own helpers in three steps — found, take, drafts. */
export function ForgeScreen({ rpc, projectId, runId }: { rpc: Rpc; projectId: string; runId: string | null }) {
  const [kind, setKind] = useState<"skill" | "role" | "workflow">("skill");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [body, setBody] = useState("");
  const [ordered, setOrdered] = useState<string | null>(null);
  const helpers = useLoad(() => (runId ? rpc.call("helpers_list", { runId }) as Promise<Helper[]> : Promise.resolve([])), [runId]);
  const receipts = useLoad(() => rpc.call("cockpit_forge_list", { projectId }) as Promise<Array<{ kind: string; name: string; ok: boolean; findings: string[] }>>, [projectId]);
  const [taken, setTaken] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Array<{ name: string; status: string }> | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Panel title={t("ckForgeOrder")} testId="ck-forge-order">
        <div className="flex flex-wrap gap-2">{(["skill", "role", "workflow"] as const).map((option) => <Button key={option} size="sm" variant={kind === option ? "default" : "outline"} onClick={() => setKind(option)}>{option}</Button>)}</div>
        <Field label={t("ckForgeName")} value={name} onChange={setName} />
        <Field label={t("ckForgeBrief")} value={brief} onChange={setBrief} multiline />
        {kind === "skill" ? <Field label={t("ckForgeBody")} value={body} onChange={setBody} multiline /> : null}
        <Button size="sm" disabled={!/^[a-z][a-z0-9-]{1,47}$/.test(name) || brief.trim().length < 20}
          onClick={() => void rpc.call("cockpit_forge_order", { projectId, kind, name, brief, ...(body.trim() ? { body } : {}) }).then(() => setOrdered(t("ckForgeOrdered")), (cause: unknown) => setOrdered(String(cause)))}>{t("ckSend")}</Button>
        {ordered ? <p className="text-xs text-muted-foreground">{ordered}</p> : null}
      </Panel>
      <Panel title={t("ckForgeDrafts")} testId="ck-forge-drafts" actions={<RefreshButton onClick={receipts.reload} />}>
        <Loaded state={receipts}>{(rows) => !rows.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
          <ul className="space-y-1 text-sm">{rows.map((row) => <li key={`${row.kind}-${row.name}`} data-testid={`ck-receipt-${row.name}`}>{row.name} — {row.ok ? t("ckDraftReady") : t("ckDraftFindings")}{!row.ok && row.findings.length ? <span className="block text-xs text-muted-foreground">{row.findings.join("; ")}</span> : null}</li>)}</ul>
        )}</Loaded>
      </Panel>
      {runId ? (
        <Panel title={t("ckOwnHelpers")} testId="ck-own-helpers" actions={<RefreshButton onClick={helpers.reload} />}>
          <p className="text-xs font-medium">1 · {t("ckStepFound")}</p>
          <Loaded state={helpers}>{(rows) => !rows.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
            <ul className="space-y-1 text-sm">{rows.map((row) => (
              <li key={row.source} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={taken.includes(row.name)} onChange={(e) => setTaken(e.target.checked ? [...taken, row.name] : taken.filter((item) => item !== row.name))} aria-label={row.name} />
                <span className="min-w-0"><span className="font-medium">{row.name}</span> <Badge variant="outline">{row.format}</Badge><span className="block truncate text-xs text-muted-foreground">{row.description || row.source}</span></span>
              </li>
            ))}</ul>
          )}</Loaded>
          <p className="text-xs font-medium">2 · {t("ckStepTake")}</p>
          <Button size="sm" disabled={!taken.length} onClick={() => void rpc.call("helpers_import", { runId, names: taken }).then((result) => setDrafts(result as Array<{ name: string; status: string }>))}>{t("ckStepTake")}</Button>
          <p className="text-xs font-medium">3 · {t("ckStepDrafts")}</p>
          {/* A taken draft waits for the person's approval and is then switched on: the press hands the two-step enable to the PM. */}
          {drafts ? <ul className="space-y-1 text-sm">{drafts.map((row) => (
            <li key={row.name} className="flex items-center gap-2">{row.name}: {row.status}
              {/written|kept/.test(row.status) ? <Button size="sm" variant="outline" disabled={enabling === row.name}
                onClick={() => { setEnabling(row.name); void rpc.call("cockpit_forge_enable", { projectId, kind: "role", name: row.name }).then(() => setDrafts(drafts.map((item) => item.name === row.name ? { ...item, status: t("ckDraftWaitsYes") } : item)), () => setEnabling(null)); }}>{t("ckDraftEnable")}</Button> : null}
            </li>))}</ul> : <p className="text-xs text-muted-foreground">{t("ckEmpty")}</p>}
        </Panel>
      ) : null}
    </div>
  );
}

/** Memory: the corpus on the machine — search across works and memory (SMA d_search), lint, the tag cloud; the drafts live under Knowledge → Rules. */
export function MemoryScreen({ rpc, runId, projectId }: { rpc: Rpc; runId: string | null; projectId: string }) {
  const [out, setOut] = useState<{ action: string; output: string; tags?: Array<{ tag: string; count: number }> } | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ records: Array<{ id: string; kind: string; content: string; concepts: string[] }>; nothingRelevant?: boolean; message?: string } | null>(null);
  // Two reads, two buttons: «rebuild the index» and «corpus review» printed the same list and rebuilt nothing (SMA audit, 2026-11-10).
  const run = (action: "lint" | "tags") => runId && void rpc.call("cockpit_memory", { runId, action }).then((result) => setOut({ action, ...(result as { output: string; tags?: Array<{ tag: string; count: number }> }) }), (cause: unknown) => setOut({ action, output: String(cause) }));
  const search = () => void rpc.call("session_memory_search", { projectId, query: query.trim(), limit: 8 }).then((result) => setFound(result as typeof found), (cause: unknown) => setFound({ records: [], message: String(cause) }));
  return (
    <Panel title={t("ckScreen_memory")} testId="ck-memory">
      <div className="space-y-2">
        <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-border bg-background px-2 text-base sm:text-sm" placeholder={t("ckMemorySearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button size="sm" disabled={!query.trim()} onClick={search}>{t("ckMemorySearchGo")}</Button></div>
        {found ? (found.records.length ? (
          <ul className="space-y-1 text-sm" data-testid="ck-memory-found">{found.records.map((row) => (
            <li key={row.id}><Badge variant="outline">{row.kind}</Badge> {row.content}{row.concepts.length ? <span className="text-xs text-muted-foreground"> · {row.concepts.join(", ")}</span> : null}</li>))}</ul>
        ) : <p className="text-sm text-muted-foreground" data-testid="ck-memory-nothing">{found.nothingRelevant ? (found.message ?? t("ckMemoryNothing")) : found.message ?? t("ckMemoryNothing")}</p>) : null}
      </div>
      {!runId ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => run("lint")}>{t("ckMemoryLint")}</Button>
            <Button size="sm" variant="outline" onClick={() => run("tags")}>{t("ckMemoryTags")}</Button>
          </div>
          {out?.tags?.length ? (
            <div className="flex flex-wrap gap-1" data-testid="ck-tags">{out.tags.map((row) => <span key={row.tag} className="rounded bg-muted px-1.5" style={{ fontSize: `${Math.min(18, 11 + row.count)}px` }}>{row.tag}</span>)}</div>
          ) : out ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-testid="ck-memory-out">{out.output}</pre> : null}
          <p className="text-xs text-muted-foreground">{t("ckMemoryDrafts")}</p>
        </div>
      )}
    </Panel>
  );
}

type FirstRun = { needed: boolean; steps: ReadonlyArray<{ id: "goal" | "writer" | "quality" | "words"; question: string }>; draft: { answers: Partial<Record<string, string>>; done?: number } };

/** First run: the interview step panel (four steps), the «ready» column of what is answered, and the finish that writes the settings. */
export function FirstRunScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const state = useLoad(() => rpc.call("first_run_get", { projectId }) as Promise<FirstRun>, [projectId]);
  const [answer, setAnswer] = useState("");
  return (
    <Panel title={t("ckScreen_firstrun")} testId="ck-first-run">
      <Loaded state={state}>{(s) => {
        if (!s.needed && s.draft.done) return <p className="text-sm text-muted-foreground">{t("ckFirstRunNotNeeded")}</p>;
        const step = s.steps.find((row) => !s.draft.answers[row.id]);
        return (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2" data-testid="ck-interview">
              {step ? (<>
                <p className="text-sm font-medium">{s.steps.indexOf(step) + 1}/4 · {step.question}</p>
                <Field label={step.id} value={answer} onChange={setAnswer} multiline />
                <Button size="sm" disabled={!answer.trim()} onClick={() => void rpc.call("first_run_answer", { projectId, step: step.id, answer }).then(() => { setAnswer(""); state.reload(); }, (cause: unknown) => alert(String(cause)))}>{t("ckSend")}</Button>
              </>) : <Button size="sm" onClick={() => void rpc.call("first_run_finish", { projectId }).then(state.reload)}>{t("ckFirstRunFinish")}</Button>}
            </div>
            <div data-testid="ck-ready"><p className="mb-1 text-xs font-medium text-muted-foreground">{t("ckFirstRunReady")}</p>
              <ul className="space-y-1 text-sm">{s.steps.filter((row) => s.draft.answers[row.id]).map((row) => <li key={row.id}>✓ {row.id}: {s.draft.answers[row.id]}</li>)}</ul></div>
          </div>
        );
      }}</Loaded>
    </Panel>
  );
}

/** Coordination: the terminals' claims on the run's checkout, and clearing one with a reason. */
export function CoordScreen({ rpc, runId }: { rpc: Rpc; runId: string | null }) {
  const status = useLoad(() => (runId ? rpc.call("coord_status", { runId }) as Promise<{ output: string }> : Promise.resolve({ output: "" })), [runId]);
  const [session, setSession] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Panel title={t("ckScreen_coord")} testId="ck-coord" actions={<RefreshButton onClick={status.reload} />}>
      <Loaded state={status}>{(s) => <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{s.output || t("ckEmpty")}</pre>}</Loaded>
      {runId ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t("ckCoordClear")}</p>
          <Field label={t("ckCoordSession")} value={session} onChange={setSession} />
          <Field label={t("ckCoordReason")} value={reason} onChange={setReason} />
          <Button size="sm" disabled={!session.trim() || reason.trim().length < 3} onClick={() => void rpc.call("coord_clear", { runId, session, reason }).then(status.reload)}>{t("ckSend")}</Button>
        </div>
      ) : null}
    </Panel>
  );
}

/** Ship: the ship gate and publish run as the workflows validate-phase, pr-branch and ship; and the Lane Stack update on the machine. */
export function ShipScreen({ rpc, projectId, hostId }: { rpc: Rpc; projectId: string; hostId: string | null }) {
  const [phaseId, setPhaseId] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [push, setPush] = useState<string[]>([]);
  const start = (id: "validate-phase" | "pr-branch" | "ship") => void rpc.call("workflow_run", { id, projectId, inputs: { phase_id: phaseId } }).then((result) => {
    setSaid(fill("ckShipStarted", { s: JSON.stringify(result).slice(0, 160) }));
    // The push stays with a person (SMA m_sw_ship): the ship workflow hands the commands back in its outputs.
    setPush(id === "ship" ? pushCommands(result) : []);
  }, (cause: unknown) => setSaid(String(cause)));
  const update = (apply: boolean) => hostId && void rpc.call("cockpit_update", { hostId, apply }).then((result) => setSaid((result as { output: string }).output.slice(0, 600)));
  return (
    <Panel title={t("ckScreen_ship")} testId="ck-ship">
      <p className="text-sm text-muted-foreground">{t("ckShipLead")}</p>
      <Field label="phase_id" value={phaseId} onChange={setPhaseId} />
      <div className="flex flex-wrap gap-2">{(["validate-phase", "pr-branch", "ship"] as const).map((id) => <Button key={id} size="sm" variant="outline" disabled={!phaseId.trim()} onClick={() => start(id)}>{fill("ckShipRun", { w: id })}</Button>)}</div>
      {push.length ? <pre data-testid="ck-ship-push" className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{push.join("\n")}</pre> : null}
      {hostId ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => update(false)}>{t("ckUpdateCheck")}</Button><Button size="sm" variant="outline" onClick={() => update(true)}>{t("ckUpdate")}</Button></div> : null}
      {said ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{said}</pre> : null}
    </Panel>
  );
}

/** The push/PR command lines a ship run's output carries, wherever the workflow put them. */
export function pushCommands(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (item: unknown, depth: number) => {
    if (depth > 8 || item === null || item === undefined) return;
    if (typeof item === "string") { for (const line of item.split("\n")) if (/\b(git push|gh pr create)\b/.test(line)) found.add(line.trim()); return; }
    if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return; }
    if (typeof item === "object") { for (const child of Object.values(item)) walk(child, depth + 1); }
  };
  walk(value, 0);
  return [...found];
}

/** System: the console — the actions journal, the machines (rows and joining one), who sees the door, faults, screen views, reads nobody calls. */
export function SystemScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const actions = useLoad(() => rpc.call("actions_recent", { limit: 100 }) as Promise<Array<{ at: number; action: string; keys: string[] }>>, []);
  const peers = useLoad(() => rpc.call("peers_list", {}) as Promise<Array<{ hostId: string; name: string | null; online: boolean; line: string }>>, []);
  const door = useLoad(() => rpc.call("door_audience", {}) as Promise<{ door: string; reachedOver: string; machines: string[] }>, []);
  const seen = useLoad(() => rpc.call("cockpit_seen_list", {}) as Promise<{ seen: Record<string, { views: number; ms: number }>; rpcs: string[] }>, []);
  return (
    <div className="space-y-4">
      <Panel title={t("ckMachines")} testId="ck-machines" actions={<RefreshButton onClick={peers.reload} />}>
        <Loaded state={peers}>{(rows) => <ul className="space-y-1 text-sm">{rows.map((row) => <li key={row.hostId} className="flex items-center gap-2"><span className={`size-2 rounded-full ${row.online ? "bg-emerald-500" : "bg-muted-foreground"}`} />{row.line}</li>)}</ul>}</Loaded>
        <p className="text-xs text-muted-foreground">{t("ckPeerJoin")}</p>
        <p className="text-xs text-muted-foreground">{t("ckPeerRemove")}</p>
        <p className="font-mono text-xs text-muted-foreground">{fill("ckTerminal", { p: projectId })}</p>
        {/* The window the person's own terminal spends is on Money → Аккаунты; this is only the how-to footnote. */}
      </Panel>
      <Panel title={t("ckDoor")} testId="ck-door">
        <Loaded state={door}>{(d) => <div className="text-sm"><p>{d.door} · {d.reachedOver}</p><p className="text-xs text-muted-foreground">{t("ckRemote")}</p></div>}</Loaded>
      </Panel>
      <Panel title={t("ckActions")} testId="ck-actions" actions={<RefreshButton onClick={actions.reload} />}>
        <Loaded state={actions}>{(rows) => <ul className="max-h-72 space-y-0.5 overflow-auto text-xs">{[...rows].reverse().map((row) => <li key={`${row.at}-${row.action}`}><span className="tabular-nums text-muted-foreground">{day(row.at)}</span> {row.action} <span className="text-muted-foreground">{row.keys.join(", ")}</span></li>)}</ul>}</Loaded>
      </Panel>
      <Panel title={t("ckSeen")} testId="ck-seen">
        <Loaded state={seen}>{(data) => {
          const unused = unusedReads(data.rpcs, COCKPIT_READS);
          return (<>
            <ul className="text-xs">{SCREENS.map((screen) => <li key={screen.id}>{t(screen.title)}: {data.seen[screen.id]?.views ?? 0} · {Math.round((data.seen[screen.id]?.ms ?? 0) / 1000)} s</li>)}</ul>
            {unused.length ? <p className="text-xs text-muted-foreground">{t("ckUnusedReads")}: {unused.slice(0, 20).join(", ")}</p> : null}
          </>);
        }}</Loaded>
      </Panel>
    </div>
  );
}
