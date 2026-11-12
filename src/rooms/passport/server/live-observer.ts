import { anamnesisFor, type OwnerMessage } from "../../anamnesis";
import type { ServerCore } from "../../contracts/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import type { LanePilotDatabase } from "../../storage";
import {
  appendVerbatim,
  formatClaimValue,
  getPassport,
  getPassportClaimAt,
  listVerbatim,
  patchPassportHypothesis,
  type ClaimStatus,
} from "../index";
import { syncPassportCoreMemory } from "./executors";

export interface ExtractedChatSignal {
  fieldPath: string;
  status: ClaimStatus;
  value: unknown;
  reason: string;
}

const CLAUSE_NEGATION_RE =
  /(?:^|[\s(«"'])(?:не|нет|ни|никак\S*|отказ\S*|запрещ\S*|исключ\S*|кроме|not|no|never|without|avoid\S*|drop\S*|exclud\S*)(?=$|[\s.,;:!?)»"'])/i;

function mapCountryToken(raw: string): { code: string; isBroadRegion: boolean } | null {
  const s = raw.toLowerCase();
  if (/^(?:рф|росси\S*|рунет\S*|russia|ru)$/.test(s)) return { code: "RU", isBroadRegion: false };
  if (/^(?:сша|us|usa|америк\S*)$/.test(s)) return { code: "US", isBroadRegion: false };
  if (/^(?:великобритан\S*|uk|gb|британ\S*)$/.test(s)) return { code: "GB", isBroadRegion: false };
  if (/^(?:германи\S*|de|germany)$/.test(s)) return { code: "DE", isBroadRegion: false };
  if (/^(?:казахстан\S*|kz)$/.test(s)) return { code: "KZ", isBroadRegion: false };
  if (/^(?:европ\S*|eu|europe|запад\S*)$/.test(s)) return { code: "EU", isBroadRegion: true };
  return null;
}

/**
 * High-precision deterministic signal extractor for explicit owner statements in ordinary/PM chats (`ASTRA-F-012`):
 * - Splits sentences into clauses and checks negation locally so `"Не используем Stripe"` never becomes `payment_rails: ["Stripe"]`
 *   and `"Не делаем проект для США, делаем для России"` emits `excluded_countries: ["US"]` + `primary_countries: ["RU"]`.
 * - Never fabricates specific country lists (`DE/NL/GB`) or `confirmed` locales from broad region names (`"для Европы"` -> `["EU"]` `hypothesis`).
 */
export function extractExplicitPassportSignals(text: string): ExtractedChatSignal[] {
  const clean = text.trim();
  if (clean.length < 12 || clean.length > 8_000) return [];
  if (
    clean.endsWith("?") &&
    clean.split("\n").length === 1 &&
    !/(строго|только|не\s+используем|запрещ|табу|делаем\s+(?:под|для))/i.test(clean)
  ) {
    return [];
  }

  const out: ExtractedChatSignal[] = [];
  const primaryCountries: string[] = [];
  let primaryCountriesConfirmed = true;
  const excludedCountries: string[] = [];
  const explicitLocales: string[] = [];

  // Split by sentence/comma clauses so negations stay scoped to their own clause
  const clauses = clean
    .split(/(?:[.;!?\n]+|,\s+)/)
    .map((c) => c.trim())
    .filter(Boolean);

  const countryAlt = "(?:рф|росси\\S*|рунет\\S*|russia|\\bru\\b|сша|\\bus\\b|\\busa\\b|америк\\S*|великобритан\\S*|\\buk\\b|германи\\S*|казахстан\\S*|\\bkz\\b|европ\\S*|\\beu\\b|europe|запад\\S*)";

  for (const clause of clauses) {
    // 1a. Explicit exclusion sub-phrases inside a clause (e.g. "под рынок США без РФ", "не делаем проект для США", "исключаем РФ", "no Russia")
    const exclPatterns = [
      new RegExp(`(?:^|[\\s(«"'])(?:без|кроме|исключ\\S*|никак\\S*)\\s+(?:рынк\\S*\\s+)?(${countryAlt})`, "gi"),
      new RegExp(`(?:^|[\\s(«"'])не\\s+(?:делаем|идём|идем|работаем|таргетир\\S*|выходим|ориентир\\S*)?\\s*(?:проект\\s+|сайт\\s+|сервис\\s+|продукт\\s+)?(?:в|на|под|для)\\s+(?:рынок\\s+|рынке\\s+)?(${countryAlt})`, "gi"),
      new RegExp(`(?:^|[\\s(«"'])(?:no|without|exclude|excluding|not\\s+(?:for|targeting|in))\\s+(?:the\\s+)?(${countryAlt})`, "gi"),
    ];
    for (const re of exclPatterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(clause)) !== null) {
        const mapped = mapCountryToken(m[1]!);
        if (mapped && !excludedCountries.includes(mapped.code)) {
          excludedCountries.push(mapped.code);
        }
      }
    }

    // Strip trailing `без ... / кроме ... / without ...` before checking positive market declarations in the same clause
    const positivePart = clause.replace(/(?:^|[\s(«"'])(?:без|кроме|исключ\S*|without|excluding|\bno\b)\s+.*$/i, "").trim();

    if (positivePart && !CLAUSE_NEGATION_RE.test(positivePart)) {
      const posMarketRe = new RegExp(
        `(?:(?:делаем|строим|запускаем|ориентир\\S*|таргетир\\S*)\\s+(?:проект\\s+|сайт\\s+|сервис\\s+|продукт\\s+)?(?:строго\\s+|только\\s+)?(?:под|для|на)\\s+(?:рынок\\s+)?|\\btarget(?:ing)?\\s+(?:only\\s+)?(?:the\\s+)?)(${countryAlt})(?:\\s+market)?`,
        "gi",
      );
      let pm: RegExpExecArray | null;
      while ((pm = posMarketRe.exec(positivePart)) !== null) {
        const mapped = mapCountryToken(pm[1]!);
        if (mapped && !excludedCountries.includes(mapped.code)) {
          if (!primaryCountries.includes(mapped.code)) primaryCountries.push(mapped.code);
          if (mapped.isBroadRegion) primaryCountriesConfirmed = false;
        }
      }
      if (/\bus-only\s+saas\b/i.test(positivePart) && !primaryCountries.includes("US")) {
        primaryCountries.push("US");
      }
    }

    // 1b. Explicit language/locale declarations (only confirmed when owner explicitly names the language!)
    if (positivePart && !CLAUSE_NEGATION_RE.test(positivePart)) {
      if (/(?:на\s+английск\S*\s*(?:язык\S*)?|англоязычн\S*|\bin\s+english\b|\benglish[- ]only\b)/i.test(positivePart)) {
        if (!explicitLocales.includes("en-US")) explicitLocales.push("en-US");
      }
      if (/(?:на\s+русск\S*\s*(?:язык\S*)?|русскоязычн\S*|\bin\s+russian\b|\brussian[- ]only\b)/i.test(positivePart)) {
        if (!explicitLocales.includes("ru-RU")) explicitLocales.push("ru-RU");
      }
    }

    // 2. Payment rail statement (only when NOT negated in the clause!)
    const railMatch = /\b(stripe|paddle|юkassa|yookassa|cloudpayments|robokassa)\b/i.exec(clause);
    if (
      railMatch &&
      !CLAUSE_NEGATION_RE.test(clause) &&
      /(оплат\S*|платёж\S*|платеж\S*|принимаем|через|checkout|billing|подписк\S*|эквайринг\S*)/i.test(clause)
    ) {
      const rawRail = railMatch[1]!.toLowerCase();
      const canonical =
        rawRail === "stripe"
          ? "Stripe"
          : rawRail === "paddle"
            ? "Paddle"
            : rawRail === "cloudpayments"
              ? "CloudPayments"
              : rawRail === "robokassa"
                ? "Robokassa"
                : "ЮKassa";
      out.push({
        fieldPath: "market_rails.payment_rails",
        status: "confirmed",
        value: [canonical],
        reason: "Owner explicitly specified payment processor in chat",
      });
    }

    // 3. Explicit price point statement (only when NOT negated in the clause!)
    const priceMatch =
      /(?:цена|чек|тариф|подписка|стоимость|pricing|price\s+is)\s*(?:будет|составит|=|:|—|-)?\s*((?:\$|€|₽)\s*\d+(?:[.,]\d+)?(?:\s*\/\s*(?:mo|month|мес|год|yr))?|\d+\s*(?:usd|eur|rub|руб|\$|€)(?:\s*\/\s*(?:mo|мес))?)/i.exec(
        clause,
      );
    if (priceMatch?.[1] && !CLAUSE_NEGATION_RE.test(clause)) {
      const isHyp = /(гипотез\S*|попробуем|думаю\s+поставить|предполагаем|maybe|test)/i.test(clause);
      out.push({
        fieldPath: "economics_funnel.price_point",
        status: isHyp ? "hypothesis" : "confirmed",
        value: priceMatch[1].trim(),
        reason: "Owner stated price point in chat",
      });
    }
  }

  if (primaryCountries.length > 0) {
    const isHyp = !primaryCountriesConfirmed || /(гипотез\S*|попробуем|возможно|maybe)/i.test(clean);
    out.push({
      fieldPath: "market_rails.primary_countries",
      status: isHyp ? "hypothesis" : "confirmed",
      value: primaryCountries,
      reason: isHyp
        ? "Owner mentioned broad target region/market hypothesis in chat"
        : "Owner explicitly declared target country in chat",
    });
  }

  if (explicitLocales.length > 0) {
    out.push({
      fieldPath: "market_rails.ui_locales",
      status: "confirmed",
      value: explicitLocales,
      reason: "Owner explicitly declared UI/content language in chat",
    });
    out.push({
      fieldPath: "market_rails.content_locales",
      status: "confirmed",
      value: explicitLocales,
      reason: "Owner explicitly declared UI/content language in chat",
    });
  } else if (primaryCountries.length === 1 && (primaryCountries[0] === "US" || primaryCountries[0] === "RU")) {
    const inferredLocale = primaryCountries[0] === "US" ? ["en-US"] : ["ru-RU"];
    out.push({
      fieldPath: "market_rails.ui_locales",
      status: "hypothesis",
      value: inferredLocale,
      reason: `Inferred default locale hypothesis from primary country ${primaryCountries[0]}`,
    });
    out.push({
      fieldPath: "market_rails.content_locales",
      status: "hypothesis",
      value: inferredLocale,
      reason: `Inferred default locale hypothesis from primary country ${primaryCountries[0]}`,
    });
  }

  if (excludedCountries.length > 0) {
    out.push({
      fieldPath: "market_rails.excluded_countries",
      status: "taboo",
      value: excludedCountries,
      reason: "Owner explicitly excluded country/region in chat",
    });
  }

  // 4. Explicit banned words / taboos
  const tabooMatch = /(?:запрещены\s+слова|стоп-слова|не\s+используй(?:те)?\s+слова|banned\s+words)\s*[:—-]\s*([^\n.]{3,160})/i.exec(clean);
  if (tabooMatch?.[1]) {
    const words = tabooMatch[1]
      .split(/[,;]+/)
      .map((s) => s.replace(/["«»']/g, "").trim())
      .filter(Boolean);
    if (words.length > 0) {
      out.push({
        fieldPath: "messaging_voice.banned_words",
        status: "taboo",
        value: words,
        reason: "Owner declared banned words in chat",
      });
    }
  }

  return out;
}

export function ingestOwnerMessageIntoPassport(
  db: LanePilotDatabase,
  msg: OwnerMessage,
  notifyRealtime?: (projectId: string, kind: "rules") => void,
): { capturedVerbatim: boolean; updatedFields: string[]; pendingIds: string[] } {
  if (!msg.projectId || !msg.text?.trim()) {
    return { capturedVerbatim: false, updatedFields: [], pendingIds: [] };
  }
  const signals = extractExplicitPassportSignals(msg.text);
  if (signals.length === 0) {
    return { capturedVerbatim: false, updatedFields: [], pendingIds: [] };
  }
  const alreadySeen = listVerbatim(db, msg.projectId, { limit: 25 }).some(
    (v) => v.thread_id === msg.threadId && v.owner_verbatim === msg.text.trim(),
  );
  if (alreadySeen) {
    return { capturedVerbatim: false, updatedFields: [], pendingIds: [] };
  }

  const vrb = appendVerbatim(db, {
    projectId: msg.projectId,
    source: "chat_turn",
    threadId: msg.threadId,
    ownerVerbatim: msg.text,
    extractedPaths: signals.map((s) => s.fieldPath),
    now: msg.at || Date.now(),
  });

  const updatedFields: string[] = [];
  const pendingIds: string[] = [];

  for (const sig of signals) {
    const existingPassport = getPassport(db, msg.projectId)?.passport;
    const prevClaim = existingPassport ? getPassportClaimAt(existingPassport, sig.fieldPath) : null;
    const res = patchPassportHypothesis(db, {
      projectId: msg.projectId,
      fieldPath: sig.fieldPath,
      nextStatus: sig.status,
      value: sig.value,
      evidenceRef: vrb.id,
      note: sig.reason,
      allowOverrideConfirmed: false,
      allowAdditiveAppend: true,
      updatedBy: "chat_observer",
      now: msg.at || Date.now(),
    });

    if (res.applied) {
      updatedFields.push(sig.fieldPath);
      syncPassportCoreMemory(db, msg.projectId, res.record.passport);
    } else if (res.queuedPending) {
      pendingIds.push(res.queuedPending.id);
      const itemKey = `passport_delta:${res.queuedPending.id}`;
      postOwnerItem(db, {
        key: itemKey,
        source: "workflow",
        kind: "question",
        projectId: msg.projectId,
        wake: false,
        what: `Обновить поле паспорта проекта «${sig.fieldPath}»?`,
        why: `В чате прозвучало новое значение «${formatClaimValue(sig.value)}» (раньше было подтверждено: «${formatClaimValue(prevClaim?.value)}»).`,
        evidence: [{ kind: "message", ref: msg.threadId, label: msg.text.slice(0, 120) }],
        actions: [
          {
            id: "accept",
            label: "Да, обновить паспорт",
            cli: `bb lane-pilot project-passport decide --project ${msg.projectId} --id ${res.queuedPending.id} --decision accept`,
            rpc: {
              method: "passport_decide",
              input: { projectId: msg.projectId, deltaId: res.queuedPending.id, decision: "accept" },
            },
          },
          {
            id: "reject",
            label: "Оставить как было",
            cli: `bb lane-pilot project-passport decide --project ${msg.projectId} --id ${res.queuedPending.id} --decision reject`,
            rpc: {
              method: "passport_decide",
              input: { projectId: msg.projectId, deltaId: res.queuedPending.id, decision: "reject" },
            },
          },
        ],
      });
    }
  }

  if (updatedFields.length > 0 || pendingIds.length > 0) {
    notifyRealtime?.(msg.projectId, "rules");
  }

  return { capturedVerbatim: true, updatedFields, pendingIds };
}

export function closePassportOwnerItem(db: LanePilotDatabase, deltaId: string): void {
  try {
    closeOwnerItem(db, `passport_delta:${deltaId}`, "answered");
  } catch {
    // ignore if owner_waiting table is absent in isolated test
  }
}

export function mountPassportObserver(ctx: ServerCore): void {
  try {
    const unsub = anamnesisFor(ctx).ownerMessages.subscribe({
      name: "passport",
      handle(batch, meta) {
        if (!meta.live) return;
        for (const msg of batch) {
          try {
            ingestOwnerMessageIntoPassport(ctx.db, msg, (pid, kind) => ctx.realtime?.notify(pid, kind));
          } catch (cause) {
            ctx.bb.log.warn(`Lane Pilot passport observer skipped message: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
      },
    });
    ctx.bb.onDispose(unsub);
  } catch (cause) {
    ctx.bb.log.info(`Lane Pilot passport observer did not attach: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
