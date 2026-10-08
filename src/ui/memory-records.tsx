import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { t } from "@lane-pilot/i18n";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";

type MemoryRecord = { id: string; kind: "core" | "note"; audience: string; content: string; concepts: string[]; createdAt: number; rule: boolean };

/** What the project memory holds: the facts writers may get and the rules, newest first; a fact can be removed. */
export function MemoryRecords({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRecords((await rpc.call("memory_records_list", { projectId })).records); }
    catch { setRecords([]); }
  }, [projectId, rpc]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (id: string) => {
    setBusy(id);
    try {
      const result = await rpc.call("memory_record_delete", { projectId, id });
      if (!result.deleted) toast.error(result.reason === "rule" ? t("memoryRecordIsRule") : t("memoryRecordGone"));
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(null); }
  };

  const facts = (records ?? []).filter((row) => !row.rule);
  const rules = (records ?? []).filter((row) => row.rule);
  const row = (record: MemoryRecord) => (
    <div key={record.id} className="space-y-1 rounded-md border border-border/60 p-2 text-xs" data-testid={`memory-record-${record.id.slice(0, 12)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={record.kind === "core" ? "secondary" : "outline"}>{record.kind === "core" ? t("memoryKindCore") : t("memoryKindNote")}</Badge>
        <span className="text-muted-foreground">{new Date(record.createdAt).toLocaleDateString()}</span>
        {record.rule ? null : (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" disabled={busy === record.id}
            aria-label={t("memoryRecordRemove")} onClick={() => void remove(record.id)}>{t("memoryRecordRemove")}</Button>
        )}
      </div>
      <p style={{ overflowWrap: "anywhere" }}>{record.content}</p>
      {record.concepts.length ? <p className="text-muted-foreground">{record.concepts.slice(0, 8).join(" · ")}</p> : null}
    </div>
  );

  return (
    <div className="max-w-xl space-y-2" data-testid="memory-records">
      <p className="text-xs text-muted-foreground">{t("memoryRecordsHelp")}</p>
      <Disclosure compact summary={`${t("memoryRecordsFacts")} (${records ? facts.length : "…"})`}>
        <div className="space-y-2 pt-1">{facts.length ? facts.map(row) : <p className="text-xs text-muted-foreground">{t("memoryRecordsEmpty")}</p>}</div>
      </Disclosure>
      <Disclosure compact summary={`${t("memoryRecordsRules")} (${records ? rules.length : "…"})`}>
        <div className="space-y-2 pt-1">{rules.length ? rules.map(row) : <p className="text-xs text-muted-foreground">{t("memoryRecordsEmpty")}</p>}</div>
      </Disclosure>
    </div>
  );
}
