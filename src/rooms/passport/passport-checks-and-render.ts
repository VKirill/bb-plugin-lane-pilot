import {
  type ClaimStatus,
  computePassportMetrics,
  formatClaimValue,
  getPassportClaimAt,
  isClaimFilled,
  PASSPORT_SECTIONS,
  type PassportContradiction,
  type PassportFluffWarning,
  type PassportQuestion,
  type PassportSectionId,
  type PassportV1,
  type VerbatimEntry,
  walkPassportClaims,
} from "./schema";

const FLUFF_RULES: ReadonlyArray<{ code: string; re: RegExp; remediation: string }> = [
  {
    code: "EVERYONE_ICP",
    re: /\b(for\s+everyone|for\s+all\s+businesses|all\s+entrepreneurs|any\s+company)\b|(для\s+всех|всем\s+предпринимателям|любому\s+бизнесу|широкая\s+аудитория)/i,
    remediation: "Mom Test Customer Slicing: narrow 'everyone' to a specific who+where+trigger segment.",
  },
  {
    code: "SUNDAY_BUZZWORDS",
    re: /\b(innovative\s+platform|synergistic|world-class|turnkey\s+solution|seamless\s+synergy)\b|(инновационн\S*|уникальн\S*\s+продукт|аналогов\s+нет|под\s+ключ|комплексн\S*\s+решени\S*|индивидуальный\s+подход)/i,
    remediation: "Rumelt/Wiegers Anti-Fluff: replace abstract buzzwords with concrete mechanism, time, or cost delta.",
  },
  {
    code: "HYPOTHETICAL_VALIDATION",
    re: /\b(friends\s+said\s+they\s+love|would\s+definitely\s+buy)\b|(друзья\s+сказали|точно\s+купят|обещали\s+купить)/i,
    remediation: "Mom Test Rule #2: compliments and future promises are not evidence; anchor in past behavior or tag as hypothesis.",
  },
];

export function detectPassportFluff(passport: PassportV1): PassportFluffWarning[] {
  const warnings: PassportFluffWarning[] = [];
  for (const c of walkPassportClaims(passport)) {
    if (c.status === "unknown" || c.status === "taboo") continue;
    if (c.path.endsWith("banned_words") || c.path.endsWith("forbidden_claims") || c.path.endsWith("non_goals")) continue;
    const text = formatClaimValue(c.value);
    if (!text) continue;
    for (const rule of FLUFF_RULES) {
      const m = rule.re.exec(text);
      if (m) {
        warnings.push({
          code: rule.code,
          field_path: c.path,
          matched: m[0],
          status: c.status,
          remediation: rule.remediation,
        });
      }
    }
  }
  return warnings;
}

const RU_MARKERS_RE =
  /(яндекс|директ|метрик|вебмастер|152-фз|38-фз|\berid\b|орд|юkassa|юкасса|yookassa|сбп|эльба|контур|авито|дзен|\byandex(?:_direct|\s*direct|_metrika|_webmaster)?\b|\bmetrika\b|\belba\b|vk[\s_]*ads|\+7|\brub\b|₽)/i;
const RU_CODES = new Set(["RU", "RUS", "RUSSIA", "РОССИЯ", "РФ"]);
const EAEU_CODES = new Set(["RU", "RUS", "RUSSIA", "РОССИЯ", "РФ", "BY", "KZ"]);

export function passportExcludesRu(passport: PassportV1): boolean {
  const ex = passport.market_rails.excluded_countries.value.map((x) => x.trim().toUpperCase());
  if (ex.some((c) => RU_CODES.has(c))) return true;
  const prim = passport.market_rails.primary_countries.value.map((x) => x.trim().toUpperCase()).filter(Boolean);
  const locales = [...passport.market_rails.ui_locales.value, ...passport.market_rails.content_locales.value].map((x) => x.trim().toLowerCase());
  if (prim.length > 0 && !prim.some((c) => EAEU_CODES.has(c)) && !locales.some((l) => l.startsWith("ru"))) {
    return true;
  }
  return false;
}

export function detectPassportContradictions(passport: PassportV1): PassportContradiction[] {
  const out: PassportContradiction[] = [];
  const excludesRu = passportExcludesRu(passport);
  const railsBlob = [
    formatClaimValue(passport.market_rails.payment_rails.value),
    formatClaimValue(passport.market_rails.allowed_channels.value),
    formatClaimValue(passport.market_rails.compliance_regimes.value),
    formatClaimValue(passport.market_rails.currency.value),
  ].join(" | ");

  if (excludesRu) {
    const hit = RU_MARKERS_RE.exec(railsBlob);
    if (hit) {
      out.push({
        code: "MARKET_CHANNEL_CLASH",
        severity: "high",
        fields: "market_rails.primary_countries <-> market_rails.{payment_rails,allowed_channels,compliance_regimes}",
        detail: `Project targets non-RU markets (${passport.market_rails.primary_countries.value.join(", ") || "non-RU"}), yet RU-specific rail "${hit[0]}" is configured.`,
        fix: "Remove RU-only rails (Yandex Direct, ЮKassa, 152-ФЗ, erid, RUB) or add RU to target markets.",
      });
    }
  }

  const primUpper = passport.market_rails.primary_countries.value.map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (primUpper.length > 0 && primUpper.every((c) => RU_CODES.has(c)) && /\bstripe\b/i.test(formatClaimValue(passport.market_rails.payment_rails.value))) {
    out.push({
      code: "RU_PAYMENT_CLASH",
      severity: "medium",
      fields: "market_rails.primary_countries <-> market_rails.payment_rails",
      detail: "Target market is RU-only, but Stripe is listed in payment_rails.",
      fix: "Use ЮKassa / Т-Касса / СБП / Telegram Stars for RU cards, or add international target countries.",
    });
  }

  const priceStr = formatClaimValue(passport.economics_funnel.price_point.value);
  const motionStr = formatClaimValue(passport.economics_funnel.sales_motion.value);
  const dollarMatch = /(?:\$|usd\s*)(\d+(?:\.\d+)?)/i.exec(priceStr);
  if (dollarMatch && Number(dollarMatch[1]) <= 25 && /(whatsapp\s+closer|manual\s+sales|enterprise\s+outbound|менеджер\s+вручную|холодные\s+звонки)/i.test(motionStr)) {
    out.push({
      code: "PRICE_MOTION_CLASH",
      severity: "medium",
      fields: "economics_funnel.price_point <-> economics_funnel.sales_motion",
      detail: `Low-ticket price ($${dollarMatch[1]}) paired with high-CAC manual sales motion ("${motionStr.slice(0, 60)}").`,
      fix: "Switch to self-serve PLG checkout or raise contract value to justify human sales.",
    });
  }

  const zeroProof = passport.proof_brandcore.pre_launch_zero_proof.value === true || passport.identity.stage.value === "idea_zero";
  const factsStr = [
    formatClaimValue(passport.proof_brandcore.verified_facts.value),
    formatClaimValue(passport.proof_brandcore.case_patterns.value),
  ].join(" | ");
  const hasActiveProofClaim =
    passport.proof_brandcore.verified_facts.status !== "unknown" ||
    passport.proof_brandcore.case_patterns.status !== "unknown";
  if (zeroProof && hasActiveProofClaim && /\b(\d{2,}\+?\s*(?:happy\s+)?(?:enterprise\s+)?(?:clients|customers|клиентов|компаний|отзывов|кейсов))\b/i.test(factsStr)) {
    out.push({
      code: "PROOF_STAGE_CLASH",
      severity: "high",
      fields: "proof_brandcore.pre_launch_zero_proof <-> proof_brandcore.{verified_facts,case_patterns}",
      detail: "Project is pre-launch / zero-proof, yet verified_facts or case_patterns claims dozens/hundreds of existing clients.",
      fix: "Keep verified_facts honest (founder credentials, prototype benchmarks, open methodology) and never invent client counts.",
    });
  }

  return out;
}

const TS_QUESTION_BANK: ReadonlyArray<PassportQuestion & { modes: readonly string[]; domains: readonly string[]; priority: number }> = [
  {
    id: "Q-ID-CORE",
    section: "identity",
    field_path: "identity.one_liner",
    modes: ["express", "deep_grill", "domain_delta"],
    domains: ["code", "design", "seo", "marketing", "content", "research", "games", "business"],
    priority: 100,
    framework: "Lean Canvas + Patton Backbone",
    question_ru: "Что представляет собой проект простыми словами, на какой он сейчас стадии (идея с нуля, MVP, уже работает) и какое одно главное действие человек в нём совершает?",
    question_en: "In plain words, what is this project, what stage is it at, and what single core action does a user take?",
    anti_fluff_probe: "Что человек открывает на экране и какой конкретный результат получает за первые 5 минут?",
  },
  {
    id: "Q-RAILS-LOCALE-GEO",
    section: "market_rails",
    field_path: "market_rails.primary_countries",
    modes: ["express", "deep_grill", "domain_delta"],
    domains: ["code", "design", "seo", "marketing", "content", "research", "games", "business"],
    priority: 98,
    framework: "Global Market & Locale Rails",
    question_ru: "На какие страны и языки делаем проект (интерфейс + контент), в какой валюте и через какие платёжки принимаем оплату, и какие рынки/каналы точно ИСКЛЮЧЕНЫ?",
    question_en: "Which target countries, UI/content languages, currency/payment rails, and explicitly EXCLUDED markets apply?",
    anti_fluff_probe: "Назови основной язык и 1–3 приоритетные страны для первых 100 клиентов.",
  },
  {
    id: "Q-POS-ALT-ICP",
    section: "positioning",
    field_path: "positioning.status_quo_alternatives",
    modes: ["express", "deep_grill", "domain_delta"],
    domains: ["design", "seo", "marketing", "content", "research", "code"],
    priority: 95,
    framework: "April Dunford (Obviously Awesome 5+1)",
    question_ru: "Кому эта проблема жжёт сильнее всего и ЧЕМ они затыкают эту дыру сегодня без вас (Excel, стажёр, мессенджер, конкретный конкурент или просто терпят)?",
    question_en: "Who feels this pain most acutely and what status-quo workaround do they use today without you?",
    anti_fluff_probe: "Назови конкретную роль и ситуацию вместо «всем предпринимателям».",
  },
  {
    id: "Q-POS-VALUE-CAT",
    section: "positioning",
    field_path: "positioning.core_value",
    modes: ["express", "deep_grill", "domain_delta"],
    domains: ["design", "seo", "marketing", "content"],
    priority: 90,
    framework: "April Dunford + Rumelt Kernel",
    question_ru: "Чем ваш продукт объективно отличается от старого способа и на какую понятную «полку» рынка в голове покупателя мы его ставим?",
    question_en: "What objective capability sets you apart from the status quo, and what market category makes it obvious?",
    anti_fluff_probe: "Сколько часов, денег или риска это реально экономит клиенту?",
  },
  {
    id: "Q-JTBD-SWITCH-FORCES",
    section: "audience_jtbd",
    field_path: "audience_jtbd.four_forces.push",
    modes: ["deep_grill", "domain_delta"],
    domains: ["marketing", "seo", "content", "design", "research"],
    priority: 86,
    framework: "JTBD Four Forces + Revella 5 Rings",
    question_ru: "Что происходит в день, когда человек решает искать решение (триггер), и чего он сильнее всего боится перед самой оплатой?",
    question_en: "What happens on the trigger day the buyer starts searching, and what is their #1 fear right before paying?",
    anti_fluff_probe: "Если пока не проверяли на живых клиентах — скажи прямо, запишем как рабочую гипотезу.",
  },
  {
    id: "Q-VOICE-LEXICON-TABOO",
    section: "messaging_voice",
    field_path: "messaging_voice.grunt_test",
    modes: ["express", "deep_grill", "domain_delta"],
    domains: ["content", "marketing", "design", "seo"],
    priority: 82,
    framework: "StoryBrand SB7 + Nicely Said",
    question_ru: "Как мы должны звучать с первого экрана и какие слова, обещания или штампы в этом проекте СТРОГО ЗАПРЕЩЕНЫ (табу)?",
    question_en: "How should our voice sound on the first screen, and what words or promises are strictly TABOO?",
    anti_fluff_probe: "Какие 3 вещи человек с телефона должен понять за 5 секунд?",
  },
  {
    id: "Q-ECON-FUNNEL",
    section: "economics_funnel",
    field_path: "economics_funnel.price_point",
    modes: ["deep_grill", "domain_delta"],
    domains: ["marketing", "business", "code"],
    priority: 78,
    framework: "Unit Economics & Funnel Motion",
    question_ru: "Какой целевой чек/тариф, как покупают (картой сам на сайте, триал, созвон/переписка) и какой потолок CAC допустим?",
    question_en: "What is the price/tier, self-serve vs assisted sales motion, and target max CAC?",
    anti_fluff_probe: "Даже ориентировочная вилка чека поможет агентам не строить несовместимую воронку.",
  },
  {
    id: "Q-PROOF-BRANDCORE",
    section: "proof_brandcore",
    field_path: "proof_brandcore.verified_facts",
    modes: ["deep_grill", "domain_delta"],
    domains: ["seo", "marketing", "content"],
    priority: 74,
    framework: "DrMax BrandCore & E-E-A-T",
    question_ru: "Какие твёрдые факты/доказательства есть уже сегодня (опыт, цифры, демо), или мы стартуем честно с нуля без кейсов?",
    question_en: "What hard proof exists today, or are we pre-launch with zero cases (locking fake-review protection ON)?",
    anti_fluff_probe: "Честный «ноль кейсов» включит защиту от выдуманных отзывов во всех SEO и маркетинговых графах.",
  },
  {
    id: "Q-PRODUCT-UX-RAILS",
    section: "product_design_rails",
    field_path: "product_design_rails.core_jobs",
    modes: ["deep_grill", "domain_delta"],
    domains: ["code", "design", "games"],
    priority: 70,
    framework: "Product & UX Engineering Rails",
    question_ru: "Где в первую очередь открывают продукт (мобилка 375px, десктоп, Telegram, 3D/игра), какие есть референсы и технические ограничения?",
    question_en: "What is the primary device/surface, visual references, and technical constraints?",
    anti_fluff_probe: "Что мы точно НЕ строим в текущей фазе?",
  },
];

export function selectNextPassportQuestions(
  passport: PassportV1,
  options: { mode?: string; targetDomain?: string; maxQuestions?: number } = {},
): PassportQuestion[] {
  const mode = options.mode || "express";
  const targetDomain = options.targetDomain || "";
  const cap = Math.max(1, Math.min(3, options.maxQuestions ?? 3));
  const metrics = computePassportMetrics(passport);

  const scored: Array<{ urgency: number; q: (typeof TS_QUESTION_BANK)[number] }> = [];
  for (const q of TS_QUESTION_BANK) {
    if (!q.modes.includes(mode)) continue;
    if (mode === "domain_delta" && targetDomain && !q.domains.includes(targetDomain)) continue;
    const claim = getPassportClaimAt(passport, q.field_path);
    const secScore = metrics.section_scores[q.section] ?? 0;
    const filled = claim ? isClaimFilled(claim.value) : false;
    const status = claim?.status ?? "unknown";
    if ((status === "confirmed" || status === "taboo") && filled && secScore >= 60) continue;
    if (status === "hypothesis" && mode === "express" && filled) continue;
    const urgency = q.priority + (100 - secScore) * 0.25 + (status === "unknown" ? 15 : 0);
    scored.push({ urgency, q });
  }

  scored.sort((a, b) => b.urgency - a.urgency);
  const picked: PassportQuestion[] = [];
  const usedSecs = new Set<PassportSectionId>();
  for (const { q } of scored) {
    if (picked.length >= cap) break;
    if (usedSecs.has(q.section) && scored.length > cap) continue;
    usedSecs.add(q.section);
    picked.push({
      id: q.id,
      section: q.section,
      field_path: q.field_path,
      framework: q.framework,
      question_ru: q.question_ru,
      question_en: q.question_en,
      anti_fluff_probe: q.anti_fluff_probe,
    });
  }
  return picked;
}

function statusBadge(status: ClaimStatus): string {
  switch (status) {
    case "confirmed":
      return "[CONFIRMED]";
    case "hypothesis":
      return "[HYPOTHESIS]";
    case "taboo":
      return "[TABOO]";
    default:
      return "[UNKNOWN]";
  }
}

export function renderPassportMarkdown(passport: PassportV1, verbatim: readonly VerbatimEntry[] = []): string {
  const metrics = computePassportMetrics(passport);
  const name = formatClaimValue(passport.identity.project_name.value) || "Unnamed Project";
  const lines: string[] = [
    `# Living Project Passport — ${name}`,
    "",
    `> Completeness: **${metrics.completeness_score}%** · Confirmed: **${metrics.confirmed_count}** · Hypotheses: **${metrics.hypothesis_count}** · Unknown: **${metrics.unknown_count}** · Taboos: **${metrics.taboo_count}**`,
    "",
  ];

  const sectionTitles: Record<PassportSectionId, string> = {
    identity: "1. Identity & Stage",
    market_rails: "2. Market, Language & Compliance Rails",
    positioning: "3. Positioning (Dunford 5+1)",
    audience_jtbd: "4. Audience, JTBD Four Forces & Buying Insight",
    messaging_voice: "5. StoryBrand Narrative & Verbatim Voice",
    economics_funnel: "6. Unit Economics & Funnel Motion",
    proof_brandcore: "7. BrandCore Proof & Forbidden Claims",
    product_design_rails: "8. Product, UX & Technical Rails",
  };

  for (const sec of PASSPORT_SECTIONS) {
    lines.push(`## ${sectionTitles[sec]} (${metrics.section_scores[sec]}%)`);
    for (const c of walkPassportClaims(passport[sec], sec)) {
      const shortKey = c.path.slice(sec.length + 1);
      const rendered = formatClaimValue(c.value);
      lines.push(`- **${shortKey}** ${statusBadge(c.status)}: ${rendered || "—"}${c.evidence_ref ? ` *(ref: ${c.evidence_ref})*` : ""}`);
    }
    lines.push("");
  }

  if (verbatim.length > 0) {
    lines.push("## Recent Owner Verbatim Quotes («Моими словами»)");
    for (const v of verbatim.slice(0, 8)) {
      lines.push(`- \`${v.id}\` (${new Date(v.created_at).toISOString().slice(0, 10)}): «${v.owner_verbatim.replace(/\s+/g, " ").trim()}»`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderBrandcoreProjection(passport: PassportV1): { markdown: string; json: Record<string, unknown> } {
  const name = formatClaimValue(passport.identity.project_name.value) || "Unnamed Project";
  const zeroProof = passport.proof_brandcore.pre_launch_zero_proof.value === true || passport.identity.stage.value === "idea_zero";
  const json = {
    project_name: name,
    one_liner: passport.identity.one_liner.value,
    stage: passport.identity.stage.value,
    primary_url: passport.identity.primary_url.value,
    ui_locales: passport.market_rails.ui_locales.value,
    content_locales: passport.market_rails.content_locales.value,
    primary_countries: passport.market_rails.primary_countries.value,
    excluded_countries: passport.market_rails.excluded_countries.value,
    currency: passport.market_rails.currency.value,
    best_fit_icp: { status: passport.positioning.best_fit_icp.status, value: passport.positioning.best_fit_icp.value },
    status_quo_alternatives: passport.positioning.status_quo_alternatives.value,
    unique_attributes: passport.positioning.unique_attributes.value,
    core_value: passport.positioning.core_value.value,
    market_category: passport.positioning.market_category.value,
    awareness_level: passport.audience_jtbd.awareness_level.value,
    tone_of_voice: passport.messaging_voice.tone_of_voice.value,
    owner_lexicon: passport.messaging_voice.owner_lexicon.value,
    banned_words: passport.messaging_voice.banned_words.value,
    pre_launch_zero_proof: zeroProof,
    verified_facts: passport.proof_brandcore.verified_facts.value,
    credentials_eeat: passport.proof_brandcore.credentials_eeat.value,
    forbidden_claims: passport.proof_brandcore.forbidden_claims.value,
  };
  const markdown = [
    `# BRANDCORE Projection — ${name}`,
    "",
    `- **Stage:** ${passport.identity.stage.value}`,
    `- **Primary URL:** ${passport.identity.primary_url.value || "(not live yet)"}`,
    `- **One-liner:** ${passport.identity.one_liner.value || "—"}`,
    `- **Target Countries / Locales:** ${passport.market_rails.primary_countries.value.join(", ") || "—"} (${passport.market_rails.content_locales.value.join(", ") || passport.market_rails.ui_locales.value.join(", ") || "—"})`,
    `- **Excluded Countries:** ${passport.market_rails.excluded_countries.value.join(", ") || "none"}`,
    `- **Market Category:** ${passport.positioning.market_category.value || "—"}`,
    `- **Best-Fit ICP (${passport.positioning.best_fit_icp.status}):** ${passport.positioning.best_fit_icp.value || "—"}`,
    `- **Competitive / Status-Quo Alternatives:** ${passport.positioning.status_quo_alternatives.value.join("; ") || "—"}`,
    `- **Core Provable Value:** ${passport.positioning.core_value.value || "—"}`,
    `- **Pre-Launch Zero-Proof Guard:** ${zeroProof ? "ON — NEVER invent testimonials, client counts, or fake case studies" : "OFF"}`,
    `- **Verified E-E-A-T & Facts:** ${[...passport.proof_brandcore.verified_facts.value, ...passport.proof_brandcore.credentials_eeat.value].join("; ") || "none yet"}`,
    `- **Owner Verbatim Lexicon:** ${passport.messaging_voice.owner_lexicon.value.join(", ") || "—"}`,
    `- **Forbidden Claims & Banned Words:** ${[...passport.proof_brandcore.forbidden_claims.value, ...passport.messaging_voice.banned_words.value].join("; ") || "none"}`,
    "",
  ].join("\n");
  return { markdown, json };
}

export function renderCharterDefaults(passport: PassportV1): Record<string, unknown> {
  return {
    project_name: passport.identity.project_name.value,
    stage: passport.identity.stage.value,
    primary_url: passport.identity.primary_url.value,
    primary_countries: passport.market_rails.primary_countries.value,
    excluded_countries: passport.market_rails.excluded_countries.value,
    ui_locales: passport.market_rails.ui_locales.value,
    content_locales: passport.market_rails.content_locales.value,
    currency: passport.market_rails.currency.value,
    payment_rails: passport.market_rails.payment_rails.value,
    compliance_regimes: passport.market_rails.compliance_regimes.value,
    allowed_channels: passport.market_rails.allowed_channels.value,
    forbidden_channels: passport.market_rails.forbidden_channels.value,
    pricing_model: passport.economics_funnel.pricing_model.value,
    price_point: passport.economics_funnel.price_point.value,
    sales_motion: passport.economics_funnel.sales_motion.value,
    max_cac: passport.economics_funnel.max_cac.value,
    maturity_window_days: passport.economics_funnel.maturity_window_days.value || 14,
    pre_launch_zero_proof: passport.proof_brandcore.pre_launch_zero_proof.value,
    forbidden_claims: passport.proof_brandcore.forbidden_claims.value,
  };
}
