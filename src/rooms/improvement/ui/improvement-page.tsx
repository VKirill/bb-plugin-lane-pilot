import { useState, type ReactNode } from "react";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { en, t, validationMessage, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Alert, AlertDescription, AlertTitle, Button, Disclosure, Segments, Skeleton, usePanelLayout } from "@lane-pilot/ui-kit";
import { InheritanceContext, SettingField, SettingsGroup } from "../../settings/ui";
import { useImprovement, type DryRun, type Improvement, type ImprovementView } from "./use-improvement";

const SECTIONS = ["night", "bench", "policy", "checks", "waiting", "memory"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, I18nKey> = {
  night: "imp_seg_night", bench: "imp_seg_bench", policy: "imp_seg_policy", checks: "imp_seg_checks", waiting: "imp_seg_waiting", memory: "imp_seg_memory",
};

const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const rows = new Map(VISIBLE_CATALOG.map((row) => [row.storageKey, row]));
const small = "max-w-2xl text-xs text-muted-foreground";

/** One catalog row as an editable field; the value, the draft and the save come from the screen's hook. */
function Field({ ctl, name }: { ctl: Improvement; name: string }) {
  const row = rows.get(name);
  if (!row) return null;
  return <SettingField row={row} value={ctl.displayed(name)} disabled={ctl.busyKey === name}
    onChange={(next) => void ctl.save(name, next)} onDraft={(next) => ctl.setDraft(name, next)} />;
}
const Fields = ({ ctl, names }: { ctl: Improvement; names: readonly string[] }) => <>{names.map((name) => <Field key={name} ctl={ctl} name={name} />)}</>;

function Block({ title, testId, help, children }: { title: string; testId: string; help?: string; children: ReactNode }) {
  return (
    <SettingsGroup title={title} testId={testId}>
      {help ? <p className={small}>{help}</p> : null}
      {children}
    </SettingsGroup>
  );
}

function More({ children, testId }: { children: ReactNode; testId: string }) {
  return <Disclosure summary={t("imp_g_more")} testId={testId} compact><div className="min-w-0 space-y-2 pt-2">{children}</div></Disclosure>;
}

function when(ms: number | string | null, locale: Locale): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Tile({ title, value, meta, tone, testId }: { title: string; value: string; meta?: string; tone?: "success" | "warning" | "muted"; testId: string }) {
  return (
    <div className="lp-card min-w-0 space-y-1 p-3" data-testid={testId}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>
        {tone ? <span aria-hidden className="size-2 shrink-0 rounded-full" data-tone={tone} style={{ backgroundColor: tone === "success" ? "var(--lp-success)" : tone === "warning" ? "var(--lp-warning)" : "var(--lp-outline)" }} /> : null}
      </div>
      <div className="break-words text-sm font-medium">{value}</div>
      {meta ? <div className="break-words text-xs text-muted-foreground">{meta}</div> : null}
    </div>
  );
}

/** The four numbers the owner looks at first: the night, the bench set, the policy exam and what waits for him. */
function StatusStrip({ view, locale }: { view: ImprovementView; locale: Locale }) {
  const { night, bench, policy, waiting } = view.status;
  const last = night.lastRunAt == null ? t("imp_night_never") : fill(night.lastDryRun ? "imp_night_last_dry" : "imp_night_last", { when: when(night.lastRunAt, locale) });
  const next = night.enabled && night.nextRunAt != null ? fill("imp_night_next", { when: when(night.nextRunAt, locale) }) : t("imp_night_off");
  return (
    <div className="grid grid-cols-1 gap-2 min-[560px]:grid-cols-2 xl:grid-cols-4" data-testid="improvement-status">
      <Tile testId="status-night" title={t("imp_tile_night")} value={next} meta={last} tone={night.enabled ? "success" : "muted"} />
      <Tile testId="status-bench" title={t("imp_tile_bench")} value={bench ? fill("imp_bench_size", { n: bench.tasks }) : t("imp_bench_none")} meta={bench ? fill("imp_bench_meta", { v: bench.version }) : undefined} tone={bench ? "success" : "warning"} />
      <Tile testId="status-policy" title={t("imp_tile_policy")} value={fill("imp_policy_progress", { n: policy.unseen, m: policy.needed })} meta={fill("imp_policy_meta", { v: policy.version })} tone={policy.passed ? "success" : "warning"} />
      <Tile testId="status-waiting" title={t("imp_tile_waiting")} value={waiting.total ? fill("imp_waiting_n", { n: waiting.total }) : t("imp_waiting_none")} tone={waiting.total ? "warning" : "success"} />
    </div>
  );
}

function DryRunResult({ result }: { result: DryRun }) {
  return (
    <div className="min-w-0 space-y-1 text-xs" data-testid="dry-run-result">
      <p>{fill("imp_dry_summary", { seen: result.classesSeen, picked: result.picked.length, hunts: result.hunts.length, backlog: result.backlog.length })}</p>
      {result.picked.length ? (
        <div>
          <p className="font-medium">{t("imp_dry_picked")}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{result.picked.map((pick) => <li key={`${pick.classKey}-${pick.round}`} className="break-words">{pick.classKey}: {pick.why}</li>)}</ul>
        </div>
      ) : <p className="text-muted-foreground">{t("imp_dry_none")}</p>}
      {result.stoppedBy ? <p className="text-muted-foreground">{fill("imp_dry_stopped", { why: result.stoppedBy })}</p> : null}
    </div>
  );
}

function NightSection({ ctl }: { ctl: Improvement }) {
  const { dry, dryRun } = ctl;
  return (
    <div className="space-y-6" data-testid="improvement-night">
      <p className={small}>{t("imp_night_intro")}</p>
      <Block title={t("imp_g_limits")} testId="night-limits">
        <Fields ctl={ctl} names={["wall.enabled", "wall.max_classes_per_night", "wall.rounds_per_night", "wall.bench_subset", "wall.rerun_sandbox_only"]} />
        <More testId="night-limits-more"><Fields ctl={ctl} names={["wall.recurrence_floor"]} /></More>
      </Block>
      <Block title={t("imp_g_hunt")} testId="night-hunt" help={t("imp_hunt_help")}>
        <Fields ctl={ctl} names={["wall.walks", "wall.hunters"]} />
        <More testId="night-hunt-more"><Fields ctl={ctl} names={["wall.hunter_provider", "wall.hunter_model", "wall.hunter_reasoning_effort", "wall.hunt_share_percent"]} /></More>
      </Block>
      <Block title={t("imp_g_budget")} testId="night-budget">
        <Fields ctl={ctl} names={["wall.night_token_cap"]} />
        <More testId="night-budget-more"><Fields ctl={ctl} names={["wall.assumed_repair_tokens"]} /></More>
      </Block>
      <Block title={t("imp_dry_title")} testId="night-dry" help={t("imp_dry_help")}>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={dry.state === "running"} onClick={() => void dryRun()} data-testid="dry-run-button">
            {dry.state === "running" ? t("imp_dry_running") : t("imp_dry_button")}
          </Button>
        </div>
        {dry.state === "failed" ? <p role="alert" className="break-words text-xs text-destructive">{t("imp_dry_failed")}: {dry.message}</p> : null}
        {dry.state === "done" && dry.result ? <DryRunResult result={dry.result} /> : null}
      </Block>
    </div>
  );
}

function BenchSection({ ctl, view, locale }: { ctl: Improvement; view: ImprovementView; locale: Locale }) {
  const bench = view.status.bench;
  return (
    <div className="space-y-6" data-testid="improvement-bench">
      <p className={small}>{t("imp_bench_intro")}</p>
      <Block title={t("imp_tile_bench")} testId="bench-set">
        <p className="text-sm" data-testid="bench-set-line">{bench ? fill("imp_bench_set", { v: bench.version, tasks: bench.tasks, cands: bench.candidates, when: when(bench.createdAt, locale) }) : t("imp_bench_nothing")}</p>
        <p className={small}>{t("imp_bench_cli")}</p>
      </Block>
      <Block title={t("imp_g_bench_budget")} testId="bench-budget"><Fields ctl={ctl} names={["bench.budget_tokens", "bench.budget_hours"]} /></Block>
      <Block title={t("imp_g_adopt")} testId="bench-adopt"><Fields ctl={ctl} names={["harness.adopt_by"]} /></Block>
    </div>
  );
}

function policyTitle(id: string, description: string): string {
  const key = `imp_pol_${id}`;
  return key in en ? t(key as I18nKey) : description;
}

function PolicySection({ view, locale }: { view: ImprovementView; locale: Locale }) {
  const { policy } = view;
  const exam = view.status.policy;
  const percent = Math.min(100, Math.round((exam.unseen / Math.max(1, exam.needed)) * 100));
  const accuracy = policy.accuracy == null ? null : Math.round(policy.accuracy * 100);
  const verdict = !exam.enough ? fill("imp_policy_wait", { m: exam.needed }) : exam.passed ? fill("imp_policy_pass", { acc: accuracy ?? 0 }) : fill("imp_policy_fail", { acc: accuracy ?? 0 });
  const lists: Array<{ id: string; title: string; entries: Array<{ id: string; description: string }> }> = [
    ...policy.tiers.map((tier) => ({ id: tier.tier, title: t(`imp_tier_${tier.tier}` as I18nKey), entries: tier.entries })),
    { id: "prohibitions", title: t("imp_tier_prohibitions"), entries: policy.prohibitions },
  ];
  return (
    <div className="space-y-6" data-testid="improvement-policy">
      <p className={small}>{t("imp_policy_intro")}</p>
      <Alert data-testid="policy-readonly-why">
        <AlertDescription>{t("imp_policy_why")}</AlertDescription>
      </Alert>
      <Block title={fill("imp_policy_frozen", { v: policy.version, when: when(policy.frozenAt, locale) })} testId="policy-exam">
        <p className="text-sm" data-testid="policy-exam-line">{fill("imp_policy_exam", { n: exam.unseen, m: exam.needed })}</p>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={exam.needed} aria-valuenow={Math.min(exam.unseen, exam.needed)} aria-label={fill("imp_policy_exam", { n: exam.unseen, m: exam.needed })}
          className="h-2 w-full overflow-hidden rounded-full bg-[var(--lp-well)]" data-testid="policy-exam-bar">
          <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: `${percent}%` }} />
        </div>
        <p className={small}>{verdict}</p>
        {policy.lastRun ? <p className={small}>{fill("imp_policy_last", { c: policy.lastRun.correct, t: policy.lastRun.total })}</p> : null}
      </Block>
      {lists.map((list) => (
        <Disclosure key={list.id} testId={`policy-list-${list.id}`} summary={<span className="text-sm font-medium">{list.title} · {list.entries.length}</span>}>
          <ul className="list-disc space-y-1 pl-6 pt-2 text-sm" data-testid={`policy-items-${list.id}`}>
            {list.entries.map((entry) => <li key={entry.id} className="break-words" title={entry.description}>{policyTitle(entry.id, entry.description)}</li>)}
          </ul>
        </Disclosure>
      ))}
    </div>
  );
}

function ChecksSection({ ctl }: { ctl: Improvement }) {
  return (
    <div className="space-y-6" data-testid="improvement-checks">
      <p className={small}>{t("imp_checks_intro")}</p>
      <p className={small} data-testid="checks-default-note">{t("imp_checks_default")}</p>
      <Block title={t("imp_g_baseline")} testId="checks-baseline"><Fields ctl={ctl} names={["baseline.already_built", "baseline.time_cap_sec"]} /></Block>
      <Block title={t("imp_g_during")} testId="checks-during">
        <p className={small}>{t("imp_planfact_help")}</p>
        <Field ctl={ctl} name="plan_fact.mode" />
        <p className={small}>{t("imp_critic_help")}</p>
        <Field ctl={ctl} name="critic.code.default_for_risk" />
      </Block>
      <Block title={t("imp_g_regress")} testId="checks-regress">
        <Fields ctl={ctl} names={["regress.nightly", "regress.last_n", "regress.last_days"]} />
        <More testId="checks-regress-more"><Fields ctl={ctl} names={["regress.check_cap_sec", "regress.budget_sec", "regress.bisect_steps"]} /></More>
      </Block>
    </div>
  );
}

function WaitingSection({ ctl, view }: { ctl: Improvement; view: ImprovementView }) {
  const d = view.deferrals;
  return (
    <div className="space-y-6" data-testid="improvement-waiting">
      <p className={small}>{t("imp_waiting_intro")}</p>
      <Block title={t("imp_g_push")} testId="waiting-push"><Fields ctl={ctl} names={["owner_push.enabled", "owner_push.quiet", "owner_push.timezone"]} /></Block>
      <Block title={t("imp_g_deferrals")} testId="waiting-deferrals">
        <p className="text-sm" data-testid="deferral-counts">{fill("imp_def_counts", { open: d.open, overdue: d.overdue, terms: d.needsTerm })}</p>
        <p className={small}>{t("imp_def_term")}</p>
      </Block>
    </div>
  );
}

function MemorySection({ ctl }: { ctl: Improvement }) {
  return (
    <div className="space-y-6" data-testid="improvement-memory">
      <p className={small}>{t("imp_memory_intro")}</p>
      <Block title={t("imp_g_memory")} testId="memory-notes"><Fields ctl={ctl} names={["memory.note_budget"]} /></Block>
    </div>
  );
}

const COMMANDS: Array<{ help: I18nKey; command: string }> = [
  { help: "imp_cmd_wall", command: "bb lane-pilot wall night" },
  { help: "imp_cmd_bench", command: "bb lane-pilot bench build | run | compare" },
  { help: "imp_cmd_policy", command: "bb lane-pilot policy-exam" },
  { help: "imp_cmd_coverage", command: "bb lane-pilot coverage" },
  { help: "imp_cmd_mechanize", command: "bb lane-pilot rules mechanize" },
  { help: "imp_cmd_rollback", command: "bb lane-pilot task-reverify | task-revert" },
];

function Commands() {
  return (
    <Disclosure testId="improvement-commands" summary={<span className="text-sm font-medium">{t("imp_cmd_title")}</span>}>
      <div className="min-w-0 space-y-2 pt-2">
        <p className={small}>{t("imp_cmd_help")}</p>
        <ul className="space-y-1.5">
          {COMMANDS.map((item) => (
            <li key={item.command} className="min-w-0 space-y-0.5 text-xs">
              <div className="text-muted-foreground">{t(item.help)}</div>
              <code className="block min-w-0 break-all rounded bg-secondary/60 px-2 py-1 text-[11px] leading-5">{item.command}</code>
            </li>
          ))}
        </ul>
      </div>
    </Disclosure>
  );
}

/** «Self-improvement»: every control of the loop that learns from failures, in one place, saved like any other setting at the global level. */
export function ImprovementScreen({ locale }: { locale: Locale }) {
  const ctl = useImprovement();
  const { compactChrome } = usePanelLayout();
  const [section, setSection] = useState<Section>("night");
  const { view, error, saveError } = ctl;
  return (
    <InheritanceContext.Provider value={null}>
      <section className="min-w-0 max-w-full space-y-5" data-testid="improvement-screen">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-medium">{t("imp_title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("imp_help")}</p>
        </div>
        {error && !view ? <Alert variant="destructive"><AlertTitle>{t("imp_load_failed")}</AlertTitle><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
        {!view && !error ? <div aria-busy="true" className="space-y-2" data-testid="improvement-loading"><p className="text-sm text-muted-foreground">{t("imp_loading")}</p><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div> : null}
        {view ? (
          <>
            <StatusStrip view={view} locale={locale} />
            {saveError ? (
              <Alert variant="destructive" data-testid="improvement-save-error">
                <AlertTitle className="break-words">
                  {saveError.kind === "conflict" ? t("imp_conflict") : saveError.kind === "validation" ? validationMessage(saveError.code, saveError.params) : `${t("imp_save_failed")}: ${saveError.message}`}
                </AlertTitle>
              </Alert>
            ) : null}
            <Segments testId="improvement" label={t("imp_seg_label")} compact={compactChrome} value={section} onChange={(next) => setSection(next as Section)}
              items={SECTIONS.map((id) => ({ id, label: t(SECTION_LABEL[id]) }))} />
            {section === "night" ? <NightSection ctl={ctl} /> : null}
            {section === "bench" ? <BenchSection ctl={ctl} view={view} locale={locale} /> : null}
            {section === "policy" ? <PolicySection view={view} locale={locale} /> : null}
            {section === "checks" ? <ChecksSection ctl={ctl} /> : null}
            {section === "waiting" ? <WaitingSection ctl={ctl} view={view} /> : null}
            {section === "memory" ? <MemorySection ctl={ctl} /> : null}
            <Commands />
          </>
        ) : null}
      </section>
    </InheritanceContext.Provider>
  );
}
