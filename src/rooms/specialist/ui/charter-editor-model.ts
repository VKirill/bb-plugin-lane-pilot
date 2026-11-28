import { t } from "@lane-pilot/i18n";

export interface CharterConstraintDraft {
  id: string;
  key: string;
  value: string;
  originalKind?: "array" | "number" | "string";
}

export interface CharterEditorForm {
  metric: string;
  formula: string;
  source: string;
  target: string;
  due: string;
  constraints: CharterConstraintDraft[];
  budgetDay: string;
  budgetMonth: string;
  budgetTest: string;
  channels: string;
}

export interface CharterDiffRow {
  fieldKey: string;
  label: string;
  oldValue: string;
  newValue: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formatConstraintValue(value: unknown): { text: string; kind: "array" | "number" | "string" } {
  if (Array.isArray(value)) {
    return {
      text: value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", "),
      kind: "array",
    };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { text: String(value), kind: "number" };
  }
  if (typeof value === "string") {
    return { text: value, kind: "string" };
  }
  if (value === null || value === undefined) {
    return { text: "", kind: "string" };
  }
  return { text: JSON.stringify(value), kind: "string" };
}

function readChannelsList(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (item: unknown) => {
    const text = asText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  const pushCollection = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const entry of raw) add(entry);
    } else if (asRecord(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === true) add(k);
        else if (Array.isArray(v)) pushCollection(v);
        else if (typeof v === "string" && v.trim()) add(`${k}: ${v.trim()}`);
      }
    }
  };
  pushCollection(body.channels);
  const arsenal = asRecord(body.arsenal);
  if (arsenal) {
    pushCollection(arsenal.channels);
    pushCollection(arsenal.allowed_channels);
    pushCollection(arsenal.allowed_graphs);
    if (
      arsenal.channels === undefined &&
      arsenal.allowed_channels === undefined &&
      arsenal.allowed_graphs === undefined
    ) {
      pushCollection(arsenal);
    }
  }
  return out;
}

/** Extracts editable charter fields from an arbitrary specialist `charter.body` JSON record. */
export function parseCharterForm(body: Record<string, unknown> | null | undefined): CharterEditorForm {
  const root = body ?? {};
  const ns = asRecord(root.north_star) ?? asRecord(root.northStar) ?? {};
  const budgets = asRecord(root.budgets) ?? {};

  const metric =
    asText(root.metric) ||
    asText(ns.metric_id) ||
    asText(ns.metricId) ||
    asText(ns.metric);

  const formula = asText(root.formula) || asText(ns.formula);

  const source =
    asText(root.data_source) ||
    asText(root.dataSource) ||
    asText(root.source_of_truth) ||
    asText(ns.source_of_truth) ||
    asText(ns.sourceOfTruth) ||
    asText(ns.data_source) ||
    asText(ns.dataSource);

  const target = asNumText(root.target) || asNumText(ns.target);

  const due =
    asText(root.due) ||
    asText(root.deadline) ||
    asText(ns.due) ||
    asText(ns.deadline) ||
    asText(ns.horizon_date) ||
    asText(ns.horizonDate);

  const constraintsRaw = root.constraints ?? root.guardrails;
  const constraints: CharterConstraintDraft[] = [];
  if (Array.isArray(constraintsRaw)) {
    constraintsRaw.forEach((entry, idx) => {
      const formatted = formatConstraintValue(entry);
      constraints.push({
        id: `c_${idx}`,
        key: "",
        value: formatted.text,
        originalKind: formatted.kind,
      });
    });
  } else {
    const rec = asRecord(constraintsRaw);
    if (rec) {
      Object.entries(rec).forEach(([key, val], idx) => {
        if (val === undefined || val === null) return;
        const formatted = formatConstraintValue(val);
        constraints.push({
          id: `c_${idx}`,
          key,
          value: formatted.text,
          originalKind: formatted.kind,
        });
      });
    }
  }

  const budgetDay = asNumText(budgets.daily_cap_usd) || asNumText(budgets.daily);
  const budgetMonth =
    asNumText(budgets.monthly_cap_usd) ||
    asNumText(budgets.monthly_media_cap) ||
    asNumText(budgets.monthly_usd) ||
    asNumText(budgets.monthly);
  const budgetTest = asNumText(budgets.cell_cap_usd) || asNumText(budgets.auto_test_cell_cap);

  const channels = readChannelsList(root).join(", ");

  return {
    metric,
    formula,
    source,
    target,
    due,
    constraints,
    budgetDay,
    budgetMonth,
    budgetTest,
    channels,
  };
}

/** Parses an optional non-negative finite number string. Returns `null` when empty, `"invalid"` on bad input. */
export function parseOptionalNonNegativeNumber(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
  return parsed;
}

function serializeConstraintValue(item: CharterConstraintDraft): unknown {
  const trimmed = item.value.trim();
  if (item.originalKind === "array") {
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (item.originalKind === "number" || /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return trimmed;
}

/**
 * Serializes the editor form back onto a copy of `baseBody`, keeping untouched fields
 * (`goal`, `current`, `latestThreadId`, `emergency_actions`, etc.) intact.
 */
export function buildCharterPayload(
  baseBody: Record<string, unknown> | null | undefined,
  form: CharterEditorForm,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(baseBody ?? {}) };
  delete next._version;
  delete next._sha256;

  const existingNs = asRecord(next.north_star) ?? asRecord(next.northStar) ?? {};
  const ns: Record<string, unknown> = { ...existingNs };

  const metric = form.metric.trim();
  if (metric) {
    ns.metric_id = metric;
    if ("metric" in next) next.metric = metric;
  } else {
    delete ns.metric_id;
    delete ns.metricId;
    delete ns.metric;
    delete next.metric;
  }

  const formula = form.formula.trim();
  if (formula) {
    ns.formula = formula;
    if ("formula" in next) next.formula = formula;
  } else {
    delete ns.formula;
    delete next.formula;
  }

  const source = form.source.trim();
  if (source) {
    ns.source_of_truth = source;
    delete ns.sourceOfTruth;
    delete ns.data_source;
    delete ns.dataSource;
    delete next.data_source;
    delete next.dataSource;
    delete next.source_of_truth;
  } else {
    delete ns.source_of_truth;
    delete ns.sourceOfTruth;
    delete ns.data_source;
    delete ns.dataSource;
    delete next.data_source;
    delete next.dataSource;
    delete next.source_of_truth;
  }

  const parsedTarget = parseOptionalNonNegativeNumber(form.target);
  if (typeof parsedTarget === "number") {
    ns.target = parsedTarget;
    if ("target" in next) next.target = parsedTarget;
  } else {
    delete ns.target;
    delete next.target;
  }

  const due = form.due.trim();
  if (due) {
    ns.due = due;
    delete ns.deadline;
    delete ns.horizon_date;
    delete ns.horizonDate;
    delete next.due;
    delete next.deadline;
  } else {
    delete ns.due;
    delete ns.deadline;
    delete ns.horizon_date;
    delete ns.horizonDate;
    delete next.due;
    delete next.deadline;
  }

  next.north_star = ns;
  delete next.northStar;

  // Constraints: preserve array format when the source used `constraints` array and rows have no keys;
  // otherwise store as `guardrails` key-value record.
  const nonEmptyConstraints = form.constraints.filter(
    (item) => item.key.trim() !== "" || item.value.trim() !== "",
  );
  const allKeyless = nonEmptyConstraints.every((item) => item.key.trim() === "");
  if (Array.isArray(baseBody?.constraints) && allKeyless) {
    next.constraints = nonEmptyConstraints.map((item) => item.value.trim());
    delete next.guardrails;
  } else if (nonEmptyConstraints.length > 0) {
    const guardrails: Record<string, unknown> = {};
    nonEmptyConstraints.forEach((item, idx) => {
      const k = item.key.trim() || `rule_${idx + 1}`;
      guardrails[k] = serializeConstraintValue(item);
    });
    next.guardrails = guardrails;
    delete next.constraints;
  } else {
    delete next.guardrails;
    delete next.constraints;
  }

  // Budgets: canonicalize day/month/test caps onto `budgets` while preserving extra keys like `max_active_cells`.
  const budgets: Record<string, unknown> = { ...(asRecord(next.budgets) ?? {}) };
  delete budgets.daily;
  delete budgets.monthly;
  delete budgets.monthly_media_cap;
  delete budgets.monthly_usd;
  delete budgets.auto_test_cell_cap;

  const dayNum = parseOptionalNonNegativeNumber(form.budgetDay);
  if (typeof dayNum === "number") budgets.daily_cap_usd = dayNum;
  else delete budgets.daily_cap_usd;

  const monthNum = parseOptionalNonNegativeNumber(form.budgetMonth);
  if (typeof monthNum === "number") budgets.monthly_cap_usd = monthNum;
  else delete budgets.monthly_cap_usd;

  const testNum = parseOptionalNonNegativeNumber(form.budgetTest);
  if (typeof testNum === "number") budgets.cell_cap_usd = testNum;
  else delete budgets.cell_cap_usd;

  next.budgets = budgets;

  applyChannels(next, readChannelsList(baseBody ?? {}), form.channels);
  return next;
}

/** Keeps an entry of a channel collection (array or `{name: true | "value" | [...]}`) only when its text is still listed. */
function keepListed(raw: unknown, listed: ReadonlySet<string>): unknown {
  if (Array.isArray(raw)) return raw.filter((entry) => listed.has(asText(entry)));
  const record = asRecord(raw);
  if (!record) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) out[key] = keepListed(value, listed);
    else if (value === true) { if (listed.has(key)) out[key] = value; }
    else if (typeof value === "string" && value.trim()) { if (listed.has(`${key}: ${value.trim()}`)) out[key] = value; }
    else out[key] = value;
  }
  return out;
}

/**
 * The form shows channels and the intake graph's `arsenal` (allowed channels and graphs) as one list. A removed entry leaves the
 * collection it lived in, a new one goes to `channels`, and an unchanged list leaves the body as written: specialists read it.
 */
function applyChannels(next: Record<string, unknown>, before: readonly string[], text: string): void {
  const listed = [...new Set(text.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (listed.length === before.length && listed.every((entry, index) => entry === before[index])) return;
  const keep = new Set(listed);
  const added = listed.filter((entry) => !before.includes(entry));
  const arsenal = asRecord(next.arsenal);
  if (arsenal) {
    const fields = ["channels", "allowed_channels", "allowed_graphs"].filter((key) => arsenal[key] !== undefined);
    next.arsenal = fields.length
      ? { ...arsenal, ...Object.fromEntries(fields.map((key) => [key, keepListed(arsenal[key], keep)])) }
      : keepListed(arsenal, keep);
  }
  const own = next.channels === undefined ? [] : keepListed(next.channels, keep);
  if (Array.isArray(own) || !added.length) next.channels = Array.isArray(own) ? [...own, ...added] : own;
  else next.channels = { ...(own as Record<string, unknown>), ...Object.fromEntries(added.map((entry) => [entry, true])) };
}

function formatConstraintsSummary(constraints: ReadonlyArray<CharterConstraintDraft>): string {
  if (constraints.length === 0) return "—";
  return constraints
    .map((item) => (item.key.trim() ? `${item.key.trim()}: ${item.value.trim()}` : item.value.trim()))
    .filter(Boolean)
    .join("; ") || "—";
}

function displayText(raw: string): string {
  return raw.trim() ? raw.trim() : "—";
}

/**
 * Computes changed field rows for the side-by-side old/new diff panel. The draft is read as is: `charter_approve`
 * writes the draft body as the whole charter, so a field missing from it is removed, not kept.
 */
export function computeCharterDiff(
  currentBody: Record<string, unknown> | null | undefined,
  draftBody: Record<string, unknown>,
): CharterDiffRow[] {
  const prev = parseCharterForm(currentBody);
  const next = parseCharterForm(draftBody);

  const pairs: Array<{ fieldKey: string; label: string; oldValue: string; newValue: string }> = [
    {
      fieldKey: "metric",
      label: t("consoleStaffCharterMetric"),
      oldValue: displayText(prev.metric),
      newValue: displayText(next.metric),
    },
    {
      fieldKey: "formula",
      label: t("consoleStaffCharterFormula"),
      oldValue: displayText(prev.formula),
      newValue: displayText(next.formula),
    },
    {
      fieldKey: "source",
      label: t("consoleStaffCharterDataSource"),
      oldValue: displayText(prev.source),
      newValue: displayText(next.source),
    },
    {
      fieldKey: "target",
      label: t("consoleStaffCharterEditTarget"),
      oldValue: displayText(prev.target),
      newValue: displayText(next.target),
    },
    {
      fieldKey: "due",
      label: t("consoleStaffCharterDue"),
      oldValue: displayText(prev.due),
      newValue: displayText(next.due),
    },
    {
      fieldKey: "constraints",
      label: t("consoleStaffCharterConstraints"),
      oldValue: formatConstraintsSummary(prev.constraints),
      newValue: formatConstraintsSummary(next.constraints),
    },
    {
      fieldKey: "budgetDay",
      label: t("consoleStaffCharterEditBudgetDay"),
      oldValue: displayText(prev.budgetDay),
      newValue: displayText(next.budgetDay),
    },
    {
      fieldKey: "budgetMonth",
      label: t("consoleStaffCharterEditBudgetMonth"),
      oldValue: displayText(prev.budgetMonth),
      newValue: displayText(next.budgetMonth),
    },
    {
      fieldKey: "budgetTest",
      label: t("consoleStaffCharterEditBudgetTest"),
      oldValue: displayText(prev.budgetTest),
      newValue: displayText(next.budgetTest),
    },
    {
      fieldKey: "channels",
      label: t("consoleStaffCharterChannels"),
      oldValue: displayText(prev.channels),
      newValue: displayText(next.channels),
    },
  ];

  return pairs.filter((row) => row.oldValue !== row.newValue);
}
