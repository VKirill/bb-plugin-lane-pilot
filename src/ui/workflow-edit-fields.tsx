import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, type I18nKey } from "../../i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { cn } from "@lane-pilot/ui-kit";
import { FIELD_TYPES, type FieldRow, type ModelError } from "./workflow-edit-model";

/**
 * The small controls of the property panels. A text control keeps what is typed in its own state and sends the change when the
 * owner leaves it (or presses Enter): every send is a draft patch the validator checks, so typing is not one patch per key. A value
 * that changes from outside (the architect edits the draft) replaces the text unless the owner is in the middle of typing.
 */
export const say = (error: ModelError | string): string => (typeof error === "string" ? error : Object.entries(error.vars ?? {}).reduce((line, [name, value]) => line.replace(`{${name}}`, value), t(error.key)));

const CONTROL = "h-8 text-sm";

export function Field({ label, hint, error, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: ModelError | string | null; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <label className="block text-xs font-medium" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="break-words text-xs text-destructive-text" role="alert">{say(error)}</p> : hint ? <p className="break-words text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The text of a control and its commit; `check` may refuse a value (the text stays, with the reason, and nothing is sent). */
function useBuffered(value: string, commit: (next: string) => void, check?: (next: string) => ModelError | string | null) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<ModelError | string | null>(null);
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) { setText(value); setError(null); } }, [value]);
  return {
    text, error,
    change: (next: string) => { dirty.current = true; setText(next); if (error) setError(check?.(next) ?? null); },
    finish: () => {
      dirty.current = false;
      if (text === value) { setError(null); return; }
      const refused = check?.(text) ?? null;
      setError(refused);
      if (refused) { dirty.current = true; return; }
      commit(text);
    },
  };
}

export function TextField({ label, value, onCommit, hint, check, placeholder, mono, list, testId, disabled, id }: {
  label: ReactNode; value: string; onCommit: (next: string) => void; hint?: ReactNode; check?: (next: string) => ModelError | string | null; placeholder?: string; mono?: boolean;
  /** Suggestions (a datalist): the owner may still type something else. */
  list?: readonly string[]; testId?: string; disabled?: boolean; id?: string;
}) {
  const own = useId();
  const field = useBuffered(value, onCommit, check);
  const listId = `${own}-list`;
  return (
    <Field label={label} hint={hint} error={field.error} htmlFor={id ?? own}>
      <Input id={id ?? own} className={cn(CONTROL, mono && "font-mono")} value={field.text} placeholder={placeholder} disabled={disabled} data-testid={testId} list={list?.length ? listId : undefined}
        aria-invalid={field.error ? true : undefined} onChange={(event) => field.change(event.target.value)} onBlur={field.finish}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); field.finish(); } }} />
      {list?.length ? <datalist id={listId}>{list.map((item) => <option key={item} value={item} />)}</datalist> : null}
    </Field>
  );
}

export function NumberField({ label, value, onCommit, min, max, hint, testId }: { label: ReactNode; value: number | null; onCommit: (next: number | null) => void; min?: number; max?: number; hint?: ReactNode; testId?: string }) {
  const check = (next: string): ModelError | null => {
    if (!next.trim()) return null;
    const number = Number(next);
    if (!Number.isInteger(number) || (min !== undefined && number < min) || (max !== undefined && number > max)) return { key: "wfEditErr_number", vars: { min: String(min ?? 0), max: String(max ?? "∞") } };
    return null;
  };
  return <TextField label={label} value={value === null ? "" : String(value)} hint={hint} check={check} testId={testId} onCommit={(next) => onCommit(next.trim() ? Number(next) : null)} />;
}

export function TextArea({ label, value, onCommit, rows = 4, hint, suggestions, check, testId, mono }: {
  label: ReactNode; value: string; onCommit: (next: string) => void; rows?: number; hint?: ReactNode; check?: (next: string) => ModelError | string | null; testId?: string; mono?: boolean;
  /** References a `{{` may be completed to: `input.query`, `search.items`. */
  suggestions?: readonly string[];
}) {
  const id = useId();
  const field = useBuffered(value, onCommit, check);
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const token = suggestions ? /\{\{\s*([\w.$-]*)$/.exec(field.text.slice(0, caret)) : null;
  const options = token ? suggestions!.filter((ref) => ref.toLowerCase().includes(token[1]!.toLowerCase())).slice(0, 8) : [];
  const pick = (ref: string) => {
    const before = field.text.slice(0, caret).replace(/\{\{\s*[\w.$-]*$/, `{{${ref}}}`);
    const next = before + field.text.slice(caret);
    field.change(next);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(before.length, before.length); setCaret(before.length); });
  };
  return (
    <Field label={label} hint={hint} error={field.error} htmlFor={id}>
      <div className="relative">
        <textarea id={id} ref={area} rows={rows} value={field.text} data-testid={testId} aria-invalid={field.error ? true : undefined}
          className={cn("w-full min-w-0 rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] px-3 py-2 text-sm leading-5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring", mono && "font-mono text-xs")}
          onChange={(event) => { field.change(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); }}
          onSelect={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)} onBlur={field.finish} />
        {options.length ? (
          <ul role="listbox" aria-label={t("wfEditRefs")} className="absolute inset-x-0 top-full z-20 mt-1 max-h-44 overflow-auto rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-1 shadow-md" data-testid="wf-ref-suggestions">
            {options.map((ref) => (
              <li key={ref} role="option" aria-selected={false}>
                <button type="button" className="block w-full rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-state-hover" onMouseDown={(event) => { event.preventDefault(); pick(ref); }}>{ref}</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, hint, testId, none }: {
  label: ReactNode; value: T | ""; options: ReadonlyArray<{ value: T; label: string }>; onChange: (next: T | "") => void; hint?: ReactNode; testId?: string;
  /** A first entry that clears the value. */
  none?: string;
}) {
  const id = useId();
  const CLEAR = "__none__";
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Select value={value === "" ? (none ? CLEAR : "") : value} onValueChange={(next) => onChange(next === CLEAR ? "" : next as T)}>
        <SelectTrigger id={id} className={cn(CONTROL, "w-full min-w-0")} data-testid={testId}><SelectValue placeholder={none ?? "-"} /></SelectTrigger>
        <SelectContent>
          {none ? <SelectItem value={CLEAR}>{none}</SelectItem> : null}
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SwitchField({ label, checked, onChange, hint, testId }: { label: ReactNode; checked: boolean; onChange: (next: boolean) => void; hint?: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0"><label className="block text-xs font-medium" htmlFor={id}>{label}</label>{hint ? <p className="break-words text-xs text-muted-foreground">{hint}</p> : null}</div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

/** Chips of picked names with a way to add one from a catalog (or by typing when there is none): skills, plugins, machines, secret names. */
export function ChipsField({ label, values, catalog, onChange, hint, testId, addLabel }: {
  label: ReactNode; values: readonly string[]; catalog?: ReadonlyArray<{ value: string; label?: string }>; onChange: (next: string[]) => void; hint?: ReactNode; testId?: string; addLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const free = (catalog ?? []).filter((item) => !values.includes(item.value));
  const add = (name: string) => { const clean = name.trim(); if (clean && !values.includes(clean)) onChange([...values, clean]); setDraft(""); };
  return (
    <Field label={label} hint={hint}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid={testId}>
        {values.map((name) => (
          <span key={name} className="lp-chip inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--lp-hairline)] bg-[var(--lp-well)] py-0.5 pl-2.5 pr-1 text-xs">
            <span className="min-w-0 truncate" title={name}>{catalog?.find((item) => item.value === name)?.label ?? name}</span>
            <button type="button" className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground" aria-label={t("wfEditRemoveChip").replace("{name}", name)} onClick={() => onChange(values.filter((item) => item !== name))}>×</button>
          </span>
        ))}
        {catalog ? (
          free.length ? (
            <Select value="" onValueChange={add}>
              <SelectTrigger className="h-7 w-auto min-w-28 gap-1 px-2 text-xs" aria-label={addLabel ?? t("wfEditAdd")}><SelectValue placeholder={addLabel ?? t("wfEditAdd")} /></SelectTrigger>
              <SelectContent>{free.map((item) => <SelectItem key={item.value} value={item.value}>{item.label ?? item.value}</SelectItem>)}</SelectContent>
            </Select>
          ) : null
        ) : null}
        {!catalog || !free.length ? (
          <Input className="h-7 w-36 text-xs" value={draft} placeholder={addLabel ?? t("wfEditAdd")} aria-label={addLabel ?? t("wfEditAdd")} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(draft); } }} onBlur={() => add(draft)} />
        ) : null}
      </div>
    </Field>
  );
}

/** A list of declared fields (name, type, enum values, required): outputs of a node, inputs and outputs of the workflow. */
export function FieldListEditor({ label, rows, onChange, testId, hint }: { label: ReactNode; rows: readonly FieldRow[]; onChange: (next: FieldRow[]) => void; testId?: string; hint?: ReactNode }) {
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<ModelError | null>(null);
  const names = new Set(rows.map((row) => row.name));
  const addRow = () => {
    const name = adding.trim();
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)) { setError({ key: "wfEditErr_fieldName" }); return; }
    if (names.has(name)) { setError({ key: "wfEditErr_fieldTwice", vars: { name } }); return; }
    setError(null); setAdding("");
    onChange([...rows, { name, type: "string" }]);
  };
  const replace = (index: number, next: FieldRow) => onChange(rows.map((row, at) => (at === index ? next : row)));
  return (
    <Field label={label} hint={hint} error={error}>
      <ul className="space-y-1.5" data-testid={testId}>
        {rows.map((row, index) => (
          <li key={`${row.name}:${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-xs" title={row.name}>{row.name}{row.required === false ? "?" : ""}</span>
            <Select value={row.type} onValueChange={(type) => replace(index, { ...row, type: type as FieldRow["type"], ...(type === "enum" ? { values: row.values?.length ? row.values : ["value"] } : { values: undefined }) })}>
              <SelectTrigger className="h-7 w-full px-2 text-xs" aria-label={t("wfEditFieldType").replace("{name}", row.name)}><SelectValue /></SelectTrigger>
              <SelectContent>{FIELD_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" size="sm" variant="ghost" className="size-7 p-0 text-muted-foreground" aria-label={t("wfEditRemoveField").replace("{name}", row.name)} onClick={() => onChange(rows.filter((_, at) => at !== index))}>×</Button>
            {row.type === "enum" ? (
              <div className="col-span-3 min-w-0">
                <EnumValues name={row.name} values={row.values ?? []} onCommit={(values) => replace(index, { ...row, values })} />
              </div>
            ) : null}
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-1.5">
          <Input className="h-7 min-w-0 flex-1 text-xs" value={adding} placeholder={t("wfEditFieldName")} aria-label={t("wfEditFieldName")} onChange={(event) => setAdding(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRow(); } }} />
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" onClick={addRow}>{t("wfEditAdd")}</Button>
        </li>
      </ul>
    </Field>
  );
}

function EnumValues({ name, values, onCommit }: { name: string; values: readonly string[]; onCommit: (next: string[]) => void }) {
  const field = useBuffered(values.join(", "), (next) => onCommit(next.split(",").map((part) => part.trim()).filter(Boolean)), (next) => (next.split(",").some((part) => part.trim()) ? null : { key: "wfEditErr_enumValues" }));
  return (
    <>
      <Input className="h-7 w-full font-mono text-xs" value={field.text} aria-label={t("wfEditEnumValues").replace("{name}", name)} placeholder={t("wfEditEnumPlaceholder")} onChange={(event) => field.change(event.target.value)} onBlur={field.finish}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); field.finish(); } }} />
      {field.error ? <p className="text-xs text-destructive-text" role="alert">{say(field.error)}</p> : null}
    </>
  );
}

/** A collapsible group of controls with a heading; closed groups keep a long panel short. */
export function Section({ title, children, open, testId }: { title: ReactNode; children: ReactNode; open?: boolean; testId?: string }) {
  return (
    <details className="group min-w-0 border-t border-[var(--lp-hairline)] pt-2" {...(open ? { open: true } : {})} data-testid={testId}>
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <span className="inline-block text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>›</span>{title}
      </summary>
      <div className="mt-2 space-y-3">{children}</div>
    </details>
  );
}

export const typeLabel = (type: string): string => t(`wfKind_${type}` as I18nKey);
