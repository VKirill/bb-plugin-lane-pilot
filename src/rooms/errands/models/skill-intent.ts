import { currentLogLevel, redactKnown, shouldLogLevel } from "@lane-pilot/kit";
import { stems } from "@lane-pilot/workflow-engine";
import { extractSkillSequence } from "../../contracts";
import { pmSkillName } from "../../native-agent";

export type SkillCatalogItem = {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly triggers?: readonly string[];
};

export type ResolvedSkillMatch = {
  readonly name: string;
  readonly score: number;
  readonly matchedDomains: readonly string[];
  readonly matchedStems: readonly string[];
};

export type SkillIntentLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type ResolveSkillIntentOptions = {
  readonly limit?: number;
  readonly minScore?: number;
  readonly log?: (message: string) => void;
  readonly logLevel?: SkillIntentLogLevel;
};

/** Bilingual RU/EN domain synonyms used to map owner phrasing onto skill catalog entries. */
export const SKILL_DOMAIN_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  copywriting: [
    "копирайт", "копирайтинг", "текст", "редактур", "тон", "слоган", "заголов", "русск",
    "пост", "стать", "оффер", "продающ",
    "copywrit", "copy", "editorial", "prose", "headline", "tone", "ru-text", "writing", "content", "humaniz",
  ],
  seo: [
    "seo", "сео", "поисков", "мета", "ключев", "индекс", "сниппет", "выдач",
    "schema", "sitemap", "meta", "search", "ranking", "opengraph", "canonical", "hreflang", "eeat",
  ],
  design: [
    "дизайн", "верстк", "вёрстк", "визуал", "интерфейс", "лендинг", "концепт", "референс", "стил", "типограф", "цвет",
    "design", "layout", "ui", "ux", "landing", "visual", "impeccable", "taste", "typography", "web-design", "frontend",
  ],
  qa: [
    "тест", "провер", "аудит", "ревью", "браузер", "баг", "регресс",
    "qa", "test", "verify", "audit", "review", "browser", "playwright", "vitest", "layout",
  ],
  architecture: [
    "архитектур", "структур", "модул", "границ", "контракт", "схем", "миграц",
    "architect", "boundary", "module", "contract", "schema", "migration",
  ],
};

const EXPLICIT_INTENT_RE =
  /(?<![\p{L}\p{N}])(?:скилл\p{L}*|навык\p{L}*|задеист\p{L}*|использ\p{L}*|подключ\p{L}*|примен\p{L}*|правил\p{L}*)|(?:use|apply|with|load|enable|run)\s+(?:the\s+)?skills?(?![\p{L}\p{N}])/iu;

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

const tokenize = (foldedText: string): string[] =>
  foldedText.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);

function keywordMatches(keywordRaw: string, foldedText: string, tokens: readonly string[], stemSet: ReadonlySet<string>): boolean {
  const kw = fold(keywordRaw);
  if (kw.includes("-")) {
    if (foldedText.includes(kw)) return true;
    const parts = tokenize(kw);
    return parts.length > 0 && parts.every((part) => tokens.some((tok) => (part.length <= 3 ? tok === part : tok.startsWith(part))));
  }
  if (kw.length <= 3) return tokens.includes(kw) || stemSet.has(kw);
  if (tokens.some((tok) => tok.startsWith(kw) || (tok.length >= 5 && kw.startsWith(tok)))) return true;
  for (const s of stems(kw)) if (stemSet.has(s)) return true;
  return false;
}

function matchingDomains(text: string): Map<string, number> {
  const folded = fold(text);
  const tokens = tokenize(folded);
  const stemSet = new Set(stems(text));
  const out = new Map<string, number>();
  for (const [domain, keywords] of Object.entries(SKILL_DOMAIN_SYNONYMS)) {
    let hits = 0;
    for (const kw of keywords) if (keywordMatches(kw, folded, tokens, stemSet)) hits += 1;
    if (hits > 0) out.set(domain, hits);
  }
  return out;
}

export function shouldEmitSkillLog(level: SkillIntentLogLevel, override?: SkillIntentLogLevel, hasLogger = false): boolean {
  return shouldLogLevel(level, override ?? currentLogLevel(hasLogger ? "debug" : "info"));
}

function emitLog(
  options: ResolveSkillIntentOptions | undefined,
  level: "debug" | "info",
  payload: Record<string, unknown>,
): void {
  if (!options?.log || !shouldEmitSkillLog(level, options.logLevel, true)) return;
  const tag = level === "debug" ? "DEBUG" : "INFO";
  options.log(redactKnown(`${tag} [errands.skillIntent] resolved ${JSON.stringify(payload)}`));
}

/** Detects explicit owner phrasing requesting skills or rules (RU/EN). */
export function hasExplicitSkillIntent(text: string): boolean {
  if (!text.trim()) return false;
  return EXPLICIT_INTENT_RE.test(fold(text));
}

/**
 * Matches an owner's Russian or English intent against the available skill catalog
 * using workflow-engine stems and bilingual domain synonyms.
 */
export function resolveSkillIntent(
  query: string,
  catalog: readonly SkillCatalogItem[],
  options?: ResolveSkillIntentOptions,
): ResolvedSkillMatch[] {
  const trimmedQuery = query.trim();
  const limit = Math.max(1, options?.limit ?? 6);
  const minScore = options?.minScore ?? 0.15;
  const queryFolded = fold(trimmedQuery);
  const queryTokens = tokenize(queryFolded);
  const queryStemList = [...new Set(stems(trimmedQuery))];
  const activeDomains = [...matchingDomains(trimmedQuery).keys()];

  if (!trimmedQuery || catalog.length === 0) {
    emitLog(options, "debug", { count: 0, skills: [], domains: activeDomains, queryStems: queryStemList.slice(0, 8), intent: trimmedQuery.slice(0, 120) });
    return [];
  }

  const matches: ResolvedSkillMatch[] = [];
  for (const item of catalog) {
    const name = pmSkillName(item.name).toLowerCase();
    if (!name) continue;
    const headerText = [name, ...(item.tags ?? []), ...(item.triggers ?? [])].join(" ");
    const fullText = `${headerText} ${item.description ?? ""}`.trim();
    const itemStems = new Set(stems(fullText));
    const matchedStems = queryStemList.filter((s) => itemStems.has(s));

    const headerDomains = matchingDomains(headerText);
    const fullDomains = matchingDomains(fullText);
    const matchedDomains = activeDomains.filter((d) => fullDomains.has(d));

    const nameParts = tokenize(fold(name)).filter((p) => p.length >= 2);
    const exactNameHit =
      queryTokens.includes(name) ||
      (name.includes("-") && queryFolded.includes(name)) ||
      (nameParts.length > 0 && nameParts.every((part) => queryTokens.includes(part)));
    const namePartHits = nameParts.filter((part) => queryTokens.some((tok) => (part.length <= 3 ? tok === part : tok.startsWith(part)))).length;

    let score = 0;
    if (exactNameHit) score += 0.65;
    else if (namePartHits > 0) score += 0.35 * (namePartHits / Math.max(1, nameParts.length));

    if (matchedStems.length > 0) {
      const denom = Math.max(1, Math.min(queryStemList.length, 4));
      score += 0.35 * Math.min(1, matchedStems.length / denom);
    }

    if (matchedDomains.length > 0) {
      let domainScore = 0;
      for (const d of matchedDomains) {
        const headerHits = headerDomains.get(d) ?? 0;
        const totalHits = fullDomains.get(d) ?? 0;
        domainScore += headerHits > 0
          ? 0.35 + Math.min(0.15, (headerHits - 1) * 0.05)
          : 0.2 + Math.min(0.1, Math.max(0, totalHits - 1) * 0.04);
      }
      score += Math.min(0.85, domainScore);
    }

    const bounded = Math.min(1, Number(score.toFixed(4)));
    if (bounded >= minScore) {
      matches.push({ name, score: bounded, matchedDomains, matchedStems });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const picked = matches.slice(0, limit);

  if (picked.length > 0) {
    emitLog(options, "info", {
      count: picked.length,
      skills: picked.map((m) => ({ name: m.name, score: Number(m.score.toFixed(3)) })),
      domains: activeDomains,
      intent: trimmedQuery.slice(0, 120),
    });
  } else {
    emitLog(options, "debug", {
      count: 0,
      skills: [],
      domains: activeDomains,
      queryStems: queryStemList.slice(0, 8),
      intent: trimmedQuery.slice(0, 120),
    });
  }

  return picked;
}

export type EpisodeSkillUse = { name: string; offered: boolean; read: boolean; used: boolean };

function offeredSkillNames(offered: unknown): string[] {
  const list = Array.isArray(offered) ? offered : [];
  const names: string[] = [];
  for (const item of list) {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object"
        ? String((item as Record<string, unknown>).name ?? (item as Record<string, unknown>).id ?? "")
        : "";
    const name = pmSkillName(raw).toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 16);
}

function skillReadsOf(events: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const item = ((event.data as { item?: Record<string, unknown> } | undefined)?.item ?? event) as Record<string, unknown>;
    const tool = String(item.tool ?? item.name ?? "");
    if (!/read/iu.test(tool)) continue;
    const input = (item.input ?? item.arguments ?? item.params ?? {}) as Record<string, unknown>;
    const path = String(input.path ?? input.file_path ?? input.file ?? "");
    const match = /([^/\\\s"']+)[/\\]SKILL\.md(?:["'`\s]|$)/iu.exec(path);
    if (match) out.add(pmSkillName(match[1]!).toLowerCase());
  }
  return out;
}

function directSkillCallsOf(events: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const item = ((event.data as { item?: Record<string, unknown> } | undefined)?.item ?? event) as Record<string, unknown>;
    const type = String(item.type ?? "");
    const tool = String(item.tool ?? item.name ?? "");
    if (tool !== "skill" && !tool.endsWith(".skill") && type !== "skill") continue;
    const input = (item.input ?? item.arguments ?? item.params ?? {}) as Record<string, unknown>;
    const rawId = typeof input.id === "string" ? input.id : typeof input.name === "string" ? input.name : typeof input.skill === "string" ? input.skill : "";
    const name = pmSkillName(rawId).toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

/**
 * `{name, offered, read, used}` per offered skill plus any un-offered skill opened via `SKILL.md` or invoked directly
 * via the `skill` tool (`offered: false`), capped at 16 entries.
 */
export function episodeSkills(
  offered: unknown,
  events: readonly unknown[],
  options?: { log?: (message: string) => void },
): EpisodeSkillUse[] {
  const names = offeredSkillNames(offered);
  const used = new Set(extractSkillSequence(events).map((name) => pmSkillName(name).toLowerCase()));
  const read = skillReadsOf(events);
  const directCalls = directSkillCallsOf(events);
  const offeredRows = names.map((name) => ({ name, offered: true, read: read.has(name), used: used.has(name) }));
  const seen = new Set(names);
  const extra: EpisodeSkillUse[] = [];
  for (const name of [...read, ...directCalls]) {
    if (seen.has(name)) continue;
    seen.add(name);
    extra.push({ name, offered: false, read: read.has(name), used: used.has(name) || directCalls.has(name) });
  }
  if (extra.length > 0) {
    options?.log?.(`[errands.skillIntent] unoffered_skills ${redactKnown(JSON.stringify({ count: extra.length, skills: extra.map((s) => s.name) }))}`);
  }
  return [...offeredRows, ...extra].slice(0, 16);
}
