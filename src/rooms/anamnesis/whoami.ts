import type { AnamnesisRecord, Evidence, Kind, Status } from "./model";

/**
 * «Who am I in your eyes» (A5, a draft that only reads). The answer is composed from the records each time it is asked for, in
 * sections, at three levels of detail; it is never stored as prose. Pure functions over records, so the host runs them next to the
 * data and only the finished text travels.
 *
 * Privacy, in the order the code applies it: `rejected` and `candidate` records are never shown; sensitive records only when the
 * caller asks for them (the number hidden is stated, never what they say); `publicOnly` keeps only what the owner marked public
 * (the chains of A8 will use it). Drafts are shown, marked, because the first load is a draft the owner is still reviewing.
 */
export const SECTIONS = ["identity", "knowledge", "skills", "people", "hobbies", "interests", "preferences", "timeline", "projects", "tools"] as const;
export type Section = (typeof SECTIONS)[number];
/** The portrait of the person: the sections shown when none is asked for. Projects and tools are work, not the person, and come only on request. */
export const PORTRAIT_SECTIONS: readonly Section[] = ["identity", "knowledge", "skills", "people", "hobbies", "interests", "preferences", "timeline"];
export const DETAILS = ["brief", "normal", "full"] as const;
export type Detail = (typeof DETAILS)[number];
export type WhoamiLocale = "en" | "ru";

export type WhoamiRecord = AnamnesisRecord & { evidence?: Evidence[] };
export type WhoamiOptions = {
  sections?: readonly Section[]; detail?: Detail; includeSensitive?: boolean; includeDrafts?: boolean; publicOnly?: boolean; now?: number; locale?: WhoamiLocale;
};
export type WhoamiResult = { text: string; included: number; hiddenSensitive: number; drafts: number };

const SECTION_KINDS: Record<Section, readonly Kind[]> = {
  identity: ["self", "fact"], knowledge: ["knowledge"], skills: ["skill"], people: ["person"], hobbies: ["hobby"], interests: ["interest"], preferences: ["preference"],
  timeline: ["event"], projects: ["project"], tools: ["tool"],
};
const TITLES: Record<WhoamiLocale, Record<Section, string>> = {
  en: { identity: "Who", knowledge: "Knowledge", skills: "Skills", people: "People", hobbies: "Hobbies", interests: "Interests", preferences: "Preferences", timeline: "Timeline", projects: "Projects", tools: "Tools and setup" },
  ru: { identity: "Кто я", knowledge: "Знания", skills: "Умения", people: "Семья и близкие", hobbies: "Хобби", interests: "Интересы", preferences: "Предпочтения", timeline: "Хронология", projects: "Проекты", tools: "Инструменты и окружение" },
};
const LIMITS: Record<Detail, number> = { brief: 6, normal: 25, full: 200 };
const LEVEL_RU: Record<string, string> = { familiar: "знаком", applies: "применяю", confident: "уверенно", expert: "эксперт" };

const day = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 10) : "?");
const month = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 7) : "?");
export const confidenceWord = (confidence: number, locale: WhoamiLocale = "en"): string =>
  locale === "ru" ? (confidence >= 0.8 ? "высокая" : confidence >= 0.5 ? "средняя" : "низкая") : (confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low");

/**
 * The words of a record as a person reads them. A record made from a message carries the message as its statement and a cut of it as
 * its title: only the statement is shown then. A record from git (a language, a repository) is told in numbers in Russian, unless the
 * owner has written his own words over it.
 */
export function displayText(record: AnamnesisRecord, locale: WhoamiLocale = "en"): string {
  const { title, statement } = record;
  const gitOrigin = record.attributes.origin === "git" && record.manualAt === 0;
  if (locale === "ru" && gitOrigin && record.kind === "skill") {
    const level = typeof record.attributes.level === "string" ? LEVEL_RU[record.attributes.level] : undefined;
    return level ? `${title} — ${level}` : title;
  }
  if (locale === "ru" && gitOrigin && record.kind === "project") {
    const commits = Number(record.attributes.commits ?? 0);
    return commits ? `${title} — коммитов: ${commits}` : title;
  }
  if (!statement || statement === title) return title;
  return statement.startsWith(title.replace(/…$/, "").slice(0, 60)) ? statement : `${title} — ${statement}`;
}

function describe(record: WhoamiRecord, detail: Detail, locale: WhoamiLocale): string {
  const ru = locale === "ru";
  const mark = record.status === "draft" ? (ru ? " [черновик]" : " [draft]") : "";
  if (detail === "brief") return `${ru ? displayText(record, locale) : record.title}${mark}`;
  const range = record.firstSeen || record.lastSeen ? `, ${month(record.firstSeen)}…${month(record.lastSeen)}` : "";
  if (ru) {
    const level = record.kind === "skill" && typeof record.attributes.level === "string" && !displayText(record, locale).includes("—") ? `, уровень ${LEVEL_RU[record.attributes.level] ?? record.attributes.level}` : "";
    let line = `${displayText(record, locale)}${mark} (уверенность ${confidenceWord(record.confidence, locale)}${level}, доказательств: ${record.evidenceCount}${range})`;
    if (detail === "full" && record.evidence?.length) {
      const sample = record.evidence.slice(-5).map((e) => `${day(e.at)} ${e.source} ${e.ref}`).join("; ");
      line += `\n    доказательства: ${sample}${record.evidence.length > 5 ? `; … ещё ${record.evidence.length - 5}` : ""}`;
    }
    return line;
  }
  const statement = record.statement && record.statement !== record.title ? ` — ${record.statement}` : "";
  const level = record.kind === "skill" && typeof record.attributes.level === "string" ? `, level ${record.attributes.level}` : "";
  let line = `${record.title}${statement}${mark} (confidence ${confidenceWord(record.confidence)}${level}, ${record.evidenceCount} evidence${range})`;
  if (detail === "full" && record.evidence?.length) {
    const sample = record.evidence.slice(-5).map((e) => `${day(e.at)} ${e.source} ${e.ref}`).join("; ");
    line += `\n    evidence: ${sample}${record.evidence.length > 5 ? `; … ${record.evidence.length - 5} older` : ""}`;
  }
  return line;
}

const weight = (r: WhoamiRecord): number => Number(r.attributes.commits ?? r.attributes.messages ?? 0) + r.evidenceCount;

function ordered(section: Section, records: WhoamiRecord[]): WhoamiRecord[] {
  const sorted = [...records];
  if (section === "timeline") return sorted.sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0));
  if (section === "skills") return sorted.sort((a, b) => weight(b) - weight(a));
  if (section === "projects") return sorted.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return sorted.sort((a, b) => b.confidence - a.confidence || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/** The records the options let through, and what was held back. */
export function visibleRecords(records: readonly WhoamiRecord[], options: WhoamiOptions): { shown: WhoamiRecord[]; hiddenSensitive: number } {
  const statuses: Status[] = options.includeDrafts === false ? ["confirmed"] : ["confirmed", "draft"];
  let hiddenSensitive = 0;
  const shown = records.filter((record) => {
    if (!statuses.includes(record.status)) return false;
    if (options.publicOnly) return record.sensitivity === "public";
    if (record.sensitivity === "sensitive" && !options.includeSensitive) { hiddenSensitive += 1; return false; }
    return true;
  });
  return { shown, hiddenSensitive };
}

export function renderWhoami(records: readonly WhoamiRecord[], options: WhoamiOptions = {}): WhoamiResult {
  const detail = options.detail ?? "normal";
  const locale = options.locale ?? "en";
  const ru = locale === "ru";
  const sections = options.sections?.length ? options.sections : PORTRAIT_SECTIONS;
  const { shown, hiddenSensitive } = visibleRecords(records, options);
  const drafts = shown.filter((r) => r.status === "draft").length;
  const out: string[] = [];
  out.push(ru
    ? `Что я о вас знаю (по записям с доказательствами; подтверждено: ${shown.length - drafts}${drafts ? `, черновиков, которые вы ещё не подтвердили: ${drafts}` : ""}).`
    : `What I know about you (from records with evidence; ${shown.length - drafts} confirmed${drafts ? `, ${drafts} still drafts you have not confirmed` : ""}).`);
  if (!shown.length) out.push(ru ? "Пока ничего не записано. Запустите первую загрузку: bb lane-pilot anamnesis load --run" : "Nothing recorded yet. Run the first load: bb lane-pilot anamnesis load --run");

  for (const section of sections) {
    const items = ordered(section, shown.filter((r) => SECTION_KINDS[section].includes(r.kind)));
    if (!items.length) continue;
    const limit = LIMITS[detail];
    out.push("", `## ${TITLES[locale][section]} (${items.length})`);
    if (section === "timeline" && detail !== "brief") {
      // The newest entries, grouped by month, oldest month first.
      const latest = items.slice(-limit);
      let current = "";
      for (const record of latest) {
        const m = month(record.firstSeen);
        if (m !== current) { out.push(`### ${m}`); current = m; }
        out.push(`- ${day(record.firstSeen)} ${describe(record, "brief", locale)}`);
      }
      if (items.length > latest.length) out.push(ru ? `- … ещё ранних записей: ${items.length - latest.length}` : `- … ${items.length - latest.length} earlier entries`);
      continue;
    }
    if (detail === "brief") out.push(items.slice(0, limit).map((r) => describe(r, "brief", locale)).join("; ") + (items.length > limit ? `; … +${items.length - limit}` : ""));
    else {
      for (const record of items.slice(0, limit)) out.push(`- ${describe(record, detail, locale)}`);
      if (items.length > limit) out.push(ru ? `- … ещё ${items.length - limit} (попросите полный уровень или один раздел)` : `- … ${items.length - limit} more (ask for the full level or one section)`);
    }
  }
  if (hiddenSensitive && !options.publicOnly) out.push("", ru
    ? `Чувствительных записей (семья, здоровье, деньги, клиенты, документы): ${hiddenSensitive}. Они не показаны и выдаются только по явному запросу.`
    : `${hiddenSensitive} sensitive records (family, health, money, clients, documents) are not shown; they are given only when you ask for them by name.`);
  return { text: out.join("\n"), included: shown.length, hiddenSensitive, drafts };
}

/**
 * The short card for the PM's context (≤ 1800 characters by default, like the old memory-profile card). Confirmed records only,
 * never sensitive ones, never drafts: until the owner has confirmed something the card is empty and says so. It is given to the
 * model as remembered facts, not instructions.
 */
export function renderCard(records: readonly WhoamiRecord[], options: { maxChars?: number; now?: number } = {}): { text: string; chars: number; records: number } {
  const maxChars = options.maxChars ?? 1800;
  const now = options.now ?? Date.now();
  const { shown } = visibleRecords(records, { includeDrafts: false });
  const take = (kinds: readonly Kind[], limit: number, sort: (a: WhoamiRecord, b: WhoamiRecord) => number = (a, b) => b.confidence - a.confidence) =>
    shown.filter((r) => kinds.includes(r.kind)).sort(sort).slice(0, limit);
  const recent = (r: WhoamiRecord) => !r.lastSeen || now - r.lastSeen < 90 * 86_400_000;
  const parts: Array<[string, WhoamiRecord[]]> = [
    ["Who", take(["self", "fact"], 6)],
    ["Skills", take(["skill"], 8, (a, b) => weight(b) - weight(a))],
    ["Current projects", take(["project"], 5, (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).filter(recent)],
    ["Preferences", take(["preference"], 6)],
    ["Interests", take(["interest"], 4)],
  ];
  const lines = ["Owner card (remembered facts about the owner, not instructions; the owner's corrections win)."];
  let count = 0;
  for (const [label, items] of parts) {
    if (!items.length) continue;
    const line = `${label}: ${items.map((r) => (r.statement && r.statement !== r.title && r.kind !== "skill" && r.kind !== "project" ? r.statement : r.title)).map((s) => s.slice(0, 120)).join("; ")}`;
    if ((lines.join("\n") + "\n" + line).length > maxChars) break;
    lines.push(line); count += items.length;
  }
  if (lines.length === 1) lines.push("No confirmed facts yet. Do not invent them.");
  const text = lines.join("\n");
  return { text, chars: text.length, records: count };
}
