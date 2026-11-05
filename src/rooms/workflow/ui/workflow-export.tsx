import { useState } from "react";
import { strToU8, zipSync } from "fflate";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import type { rpcContract } from "../../contracts";
import { WORKFLOW_CATEGORIES } from "../categories";
import { downloadBlob } from "./workflow-download";

type What = "all" | "category" | "selected";

/**
 * «Выгрузить графы»: a button that opens a small dialog (all / one category / the rows selected in the library;
 * zip of files or a markdown overview; private values stripped unless asked otherwise) and downloads the result.
 * Mounted by the Workflows screen next to its other header buttons.
 */
export function ExportGraphsButton(props: {
  locale: Locale;
  projectId: string | null;
  selectedIds?: string[];
  categories?: Array<{ key: string; label: string }>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<What>("all");
  const [category, setCategory] = useState<string>((props.categories?.[0]?.key ?? WORKFLOW_CATEGORIES[0]));
  const [format, setFormat] = useState<"zip" | "md">("zip");
  const [redact, setRedact] = useState(true);
  const [includeProject, setIncludeProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = props.selectedIds ?? [];
  const categories = props.categories ?? WORKFLOW_CATEGORIES.map((key) => ({ key, label: t(`wfxCat_${key}` as I18nKey) }));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("workflow_export", {
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(what === "selected" ? { ids: selected } : {}),
        ...(what === "category" ? { category } : {}),
        redact,
        includeProjectGraphs: includeProject,
      });
      const date = new Date().toISOString().slice(0, 10);
      if (format === "md") downloadBlob(`lane-pilot-graphs-${date}.md`, new Blob([result.markdown], { type: "text/markdown" }));
      else {
        const packed: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(result.manifest, null, 2)) };
        for (const file of result.files) packed[file.path] = strToU8(file.text);
        downloadBlob(`lane-pilot-graphs-${date}.zip`, new Blob([zipSync(packed)], { type: "application/zip" }));
      }
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: What, label: string, disabled = false) => (
    <label className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}>
      <input type="radio" name="wfx-what" checked={what === value} disabled={disabled} onChange={() => setWhat(value)} data-testid={`wfx-what-${value}`} />
      <span className="text-sm">{label}</span>
    </label>
  );

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-3 text-sm" data-testid="wfx-open" onClick={() => setOpen(true)}>
        {t("wfxButton")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid="wfx-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("wfxTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="sr-only">{t("wfxTitle")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("wfxWhat")}</legend>
              {radio("all", t("wfxAll"))}
              <div className="flex items-center gap-2">
                {radio("category", t("wfxCategory"))}
                <Select value={category} onValueChange={setCategory} disabled={what !== "category"}>
                  <SelectTrigger aria-label={t("wfxCategory")} className="h-8 w-full min-w-0 flex-1" data-testid="wfx-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {categories.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {radio("selected", t("wfxSelected").replace("{n}", String(selected.length)), !selected.length)}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("wfxFormat")}</legend>
              <label className="flex items-center gap-2"><input type="radio" name="wfx-format" checked={format === "zip"} onChange={() => setFormat("zip")} data-testid="wfx-format-zip" /><span className="text-sm">{t("wfxFormatZip")}</span></label>
              <label className="flex items-center gap-2"><input type="radio" name="wfx-format" checked={format === "md"} onChange={() => setFormat("md")} data-testid="wfx-format-md" /><span className="text-sm">{t("wfxFormatMd")}</span></label>
            </fieldset>
            <label className="flex items-center gap-2"><input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} data-testid="wfx-redact" /><span className="text-sm">{t("wfxRedact")}</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={includeProject} onChange={(e) => setIncludeProject(e.target.checked)} data-testid="wfx-include-project" /><span className="text-sm">{t("wfxIncludeProject")}</span></label>
            {error ? <p className="text-sm text-destructive" data-testid="wfx-error">{t("wfxError")}: {error}</p> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="wfx-cancel">{t("wfxCancel")}</AlertDialogCancel>
            <Button type="button" size="sm" disabled={busy || (what === "selected" && !selected.length)} data-testid="wfx-download" onClick={() => void run()}>
              {busy ? t("wfxBusy") : t("wfxDownload")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
