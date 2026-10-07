import type { Workflow } from "./schema";

/**
 * The workflow router (W4). Pure: no SDK, no database. It reads the catalog (workflow cards), searches it, applies the
 * priority rules and state checks of the chains spec (section 1) in code, lets a `RouterModel` choose among the top
 * candidates (a deterministic scorer is the default; a live model is plugged through the port), and either returns the
 * chosen workflow with the recorded evidence, a boundary contract and goals, or up to three clarifying questions.
 * Only `published`, not `internal` workflows are offered. The router sees cards, not graphs.
 */

export const TOP_N = 5;
export const MIN_CONFIDENCE = 60;
export const MAX_QUESTIONS = 3;
/** The per-task pipeline of a dispatch: run by Lane Pilot itself, never a choice for the PM. */
const NEVER_OFFERED = new Set(["lp-task-pipeline"]);

// ------------------------------------------------------------------ ports

/**
 * What the router knows about the environment. Every answer is `undefined` when unknown, and unknown means available:
 * only a known `false` excludes a workflow (and the reason is said).
 */
export type RouterState = {
  skill?(name: string): boolean | undefined;
  plugin?(name: string): boolean | undefined;
  secret?(name: string): boolean | undefined;
  /** A machine id (`host_...`); prose entries in `requires.machines` are not asked. */
  machine?(id: string): boolean | undefined;
  /** A project fact named in `requires.project` (`git`, `tests`, `passport`). */
  project?(key: string): boolean | undefined;
  /** Tasks of the PM's run that are not finished; used to warn before `milestone-close`. */
  openTasks?(): number | undefined;
};

/** What the model (or the deterministic scorer) sees of one candidate: the card, the search score and the rules that fired for it. */
export type RouterCard = {
  id: string;
  name: { en: string; ru: string };
  description: { en: string; ru: string };
  examples: { en: string[]; ru: string[] };
  not_for: string[];
  tags: string[];
  inputs: Array<{ name: string; type: string; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string; description?: string }>;
  requires: Workflow["requires"];
  /** Search score with rule boosts, 0 and up; a model may use it as a hint. */
  score: number;
  rules: string[];
};

export type RouterModelInput = { intent: string; context?: string; candidates: RouterCard[] };
export type RouterModelOutput = {
  /** A candidate id, or null when no candidate fits. */
  choice: string | null;
  /** 0 to 100. */
  confidence: number;
  /** Why this one: the pattern the request matches. */
  pattern: string;
  rejected: Array<{ id: string; reason: string }>;
  questions: string[];
};
export type RouterModel = (input: RouterModelInput) => Promise<RouterModelOutput>;

let pluggedModel: RouterModel | null = null;
/** Plugs the live model for every `routeIntent` call that does not pass its own; `null` goes back to the deterministic scorer. */
export const setRouterModel = (model: RouterModel | null): void => { pluggedModel = model; };

// ------------------------------------------------------------------ text

/** Lowercase, no diacritics (so ё is е and й is и on both sides of every comparison). */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
export const normalizeText = (text: string): string => fold(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь " +
  "опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы " +
  "нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя свою этой перед иногда лучше чуть том такой им более всегда конечно всю между " +
  "сделай сделать помоги нужно нужен нужна нужны хочу пожалуйста давай нам наш наши что то нибудь затем сначала " +
  "the a an and or of to in on for with from by at as is are be it its this that these those my our your me we you i do does did make please can could would should will just also some any something anything thing need want like help get let " +
  "then them they their there here what which who how why when where into over about than so if not no only all more most other such own same too very don t").split(" ").map(fold));

const RU_SUFFIXES = ["ирование", "ировать", "ование", "ения", "ений", "ению", "ением", "ости", "ость", "ому", "ему", "ого", "его", "ыми", "ими", "ами", "ями", "ать", "ять", "ить", "еть", "ует", "ают", "яют", "ает",
  "ете", "ите", "ишь", "ешь", "ила", "ило", "или", "ыла", "ыло", "ыли", "ала", "ало", "али", "ной", "ная", "ное", "ные", "ных", "ий", "ый", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ом", "ем", "ах", "ях", "ов", "ев",
  "ей", "ию", "ия", "ью", "ть", "ет", "ют", "ут", "ит", "ат", "ят", "ла", "ли", "ло", "ны", "на", "но", "ну", "ки", "ка", "ку", "ке", "ы", "и", "а", "я", "у", "ю", "е", "о", "ь"]
  .map(fold).sort((a, b) => b.length - a.length);
const EN_SUFFIXES = ["ations", "ation", "ings", "ing", "ers", "er", "ed", "ly"];
const CYRILLIC = /[Ѐ-ӿ]/;

/** Cheap suffix trimming: enough for Russian endings and English plurals and -ing/-ed, not a linguistic stemmer. */
export function stem(word: string): string {
  if (/^\d+$/.test(word)) return word;
  if (CYRILLIC.test(word)) {
    for (const suffix of RU_SUFFIXES) if (word.length - suffix.length >= 3 && word.endsWith(suffix)) { word = word.slice(0, -suffix.length); break; }
    return word.slice(0, 6);
  }
  if (/(?:ss|x|ch|sh|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) word = word.slice(0, -1);
  for (const suffix of EN_SUFFIXES) if (word.length - suffix.length >= 3 && word.endsWith(suffix)) { word = word.slice(0, -suffix.length); break; }
  return word;
}

/** Significant stems of a text, in order (stop words and one-letter tokens dropped). */
export const stems = (text: string): string[] => normalizeText(text).split(" ").filter((word) => word.length >= 2 && !STOP.has(word)).map(stem);

const grams = (text: string): Set<string> => {
  const padded = ` ${text} `, out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
};
const dice = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const gram of a) if (b.has(gram)) common += 1;
  return (2 * common) / (a.size + b.size);
};

// ------------------------------------------------------------------ signals of the request

type Signals = {
  raw: string; text: string; sig: string[]; wordCount: number; ru: boolean;
  ticket: string | null; urls: string[]; files: string[]; pr: string | null;
};

const TICKET_DENY = /^(?:UTF|SHA|MD|GPT|ISO|RFC|ES|TLS|AES|RSA|CVE|IPV|HTTP|ECMA|TS|PHP|NODE|ARM|X)-/;
const FILE_RX = /(?<![\w./@-])[\w./@-]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|jsonc?|py|md|css|scss|html|ya?ml|toml|txt|sh|sql|go|rs|java|rb|php|vue|svelte|env|lock|xml)(?![\w])/gi;

function signalsOf(text: string): Signals {
  const raw = text.trim();
  const letters = raw.match(/\p{L}/gu) ?? [];
  const cyr = letters.filter((char) => CYRILLIC.test(char)).length;
  const ticket = [...raw.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,5}-\d{1,6})(?![A-Za-z0-9])/g)].map((m) => m[1]!).find((id) => !TICKET_DENY.test(id))
    ?? raw.match(/https?:\/\/\S*\/(?:tasks?|issues?|tickets?|cards?)\/[\w-]+/i)?.[0] ?? null;
  return {
    raw, text: normalizeText(raw), sig: [...new Set(stems(raw))], wordCount: normalizeText(raw).split(" ").filter(Boolean).length,
    ru: letters.length > 0 && cyr / letters.length > 0.3,
    ticket, urls: [...raw.matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]),
    files: [...new Set(raw.match(FILE_RX) ?? [])],
    pr: /(?:\bpr|pull[ -]request|merge request|\bmr)\s*#?(\d{1,6})\b/i.exec(raw)?.[1] ?? null,
  };
}

// ------------------------------------------------------------------ priority rules (chains spec, section 1)

/** Folds the literal parts of a regex source and leaves escapes such as \\S alone (folding would lowercase them into other classes). */
const foldSource = (source: string): string => source.replace(/\\.|[^\\]+/g, (part) => (part.startsWith("\\") ? part : fold(part)));
const B = "(?<![\\p{L}\\p{N}])", E = "(?![\\p{L}\\p{N}])";
/** Word-start match of any alternative (a regex source, written in natural spelling; folded like the text). */
const p = (source: string) => new RegExp(`${B}(?:${foldSource(source)})`, "u");
/** Whole-word match of any alternative. */
const w = (source: string) => new RegExp(`${B}(?:${foldSource(source)})${E}`, "u");

type RuleOutcome = { note: string; boosts: Record<string, number>; flag?: "readonly" | "behaviour" | "tracker" };
type Rule = { id: string; apply(s: Signals, prior: ReadonlySet<string>): RuleOutcome | null };

const FIX = p("исправ|почин|поправ|чини|устран|пофикс|fix|repair|resolve|patch");
const READONLY = p("без правок|без изменени|не менять|не меняй|не меняем|ничего не (мен|прав|трога|запуск|исполн|делай)|править не надо|не надо (править|менять|запускать)|не правь|не трогай (код|файл)|только (посмотри|прочита|найди|список|причин)|просто посмотри|do not (change|edit|modify|run|touch)|don t (change|edit|modify|run|touch)|without (changing|editing|modifying|running)|no (changes|edits)|read only|nothing (more|else)|only (look|read|list|report)|just (look|list|report|read)");
const BEHAVIOUR = p("поведени\\S* (не (трога|мен)|то же|прежн)|без изменени\\S* поведени|не меняя поведени|ничего не должно измениться|внешне все как раньше|behaviou?r (unchanged|stays|same|intact)|same behaviou?r|keep\\S* (the )?behaviou?r|preserv\\S* (the )?behaviou?r|without changing behaviou?r|nothing should change|nothing changes|as before");
const UI_WORD = w("ui|ux|gui"), UI_START = p("дизайн|design|интерфейс|interface|страниц|page|экран|screen|верстк|layout|компонент|component|css|макет|mockup|frontend|front end");
const isUi = (text: string): boolean => UI_WORD.test(text) || UI_START.test(text);
const BUILD_FROM_SCRATCH = p("с нуля|from scratch|заново|design and build|design system|дизайн систем|responsive|адаптив|состояни|states|спроектируй|пиксел|pixel");
const AUDIT_WORDS = p("оцен|удобн|usabilit|аудит|audit|heuristic|насколько|how good|how usable|evaluate|critique|ux review|review (the )?(ui|ux|design|page)");
const WRITES = ["analyze-plan-execute", "full-lifecycle", "refactor", "review-fix", "quality-loop", "issue-full", "issue-quick", "companion", "impeccable-build", "test-gen", "grill-driven", "brainstorm-driven", "roadmap-driven", "blueprint-driven", "deploy"];
const some = (ids: string[], value: number): Record<string, number> => Object.fromEntries(ids.map((id) => [id, value]));
const STAGE_GROUPS = [p("plan|план|спланир"), p("implement|реализ|build|сделай|напиш|разработ|code|кодим|кодинг"), p("review|ревью|критик|code review"), p("test|тест|qa"), p("accept|приемк|merge|слить|слияни")];

/** In order: the first rules mark the area, the last ones (`tiny-edit`) only fire when nothing more specific did. */
const RULES: Rule[] = [
  { id: "tracker-ref", apply: (s) => {
    if (!s.ticket) return null;
    const small = p("просто|мелоч|опечатк|typo|minor|trivial|small|quick|быстр|одн\\S* строк|подсказк|тривиал").test(s.text);
    const review = p("review|ревью|proper|thorough|тщательн|полн|нормальн|качествен|full").test(s.text);
    return { note: `tracker task ${s.ticket}`, flag: "tracker", boosts: { "issue-full": 0.45 + (review ? 0.15 : 0) - (small && !review ? 0.1 : 0), "issue-quick": 0.45 + (small && !review ? 0.15 : 0), companion: -0.3, "analyze-plan-execute": -0.15 } };
  } },
  { id: "behaviour-kept", apply: (s) => BEHAVIOUR.test(s.text) ? { note: "behaviour must not change", flag: "behaviour", boosts: { refactor: 0.55 } } : null },
  { id: "refactor-words", apply: (s, prior) => !prior.has("behaviour-kept") && p("refactor|рефактор|упрост|simplif|restructur|реструктур|почист|reorganiz|tidy|clean up|cleanup|декомпоз|decompos|дублирован|duplicat|перегруппир").test(s.text) ? { note: "refactoring words", boosts: { refactor: 0.35 } } : null },
  { id: "read-only", apply: (s) => READONLY.test(s.text) && !BEHAVIOUR.test(s.text)
    ? { note: "the request forbids changes", flag: "readonly", boosts: some(WRITES, -0.35) } : null },
  { id: "ui-words", apply: (s) => {
    if (!isUi(s.text)) return null;
    const scratch = BUILD_FROM_SCRATCH.test(s.text), audit = AUDIT_WORDS.test(s.text);
    return { note: scratch ? "UI built from scratch" : audit ? "UI evaluation" : "UI words without a from-scratch design ask", boosts: { "impeccable-build": scratch ? 0.4 : 0, "ui-audit": audit && !scratch ? 0.35 : 0 } };
  } },
  { id: "debug", apply: (s) => {
    const diag = p("почему|отчего|из за чего|в чем причина|найди причину|причин|root cause|why |what causes|what s causing|diagnos|выясни").test(s.text);
    const symptom = p("слома|не работа|падает|падают|упал|вылета|крэш|краш|crash|fail|broken|баг|bug|ошибк|exception|зависа|hang|timeout|таймаут|blank page|белый экран|не открыва|не грузит|не запуска|doesn t work|not working|stopped working").test(s.text);
    const fix = FIX.test(s.text);
    if (diag && !fix) return { note: "asks why it fails, no fix requested", boosts: { debug: READONLY.test(s.text) ? 0.65 : 0.55 } };
    if (symptom && !fix) return { note: "describes a failure, no fix requested", boosts: { debug: 0.3 } };
    return diag ? { note: "asks why, with a fix", boosts: { debug: 0.1 } } : null;
  } },
  { id: "x-digest", apply: (s) => {
    const x = w("x|twitter|tweets?|твиттер\\S*|твит\\S*").test(s.text) || p("tweet|твит|в x ").test(s.text), tg = p("telegram|телег|тг|tg|тлг").test(s.text);
    return x && tg ? { note: "X or Twitter and Telegram", boosts: { "x-to-telegram-digest": 0.55 } } : x ? { note: "X or Twitter", boosts: { "x-to-telegram-digest": 0.25 } } : null;
  } },
  { id: "insights", apply: (s, prior) => prior.has("x-digest") ? null
    : p("instagram|инстаграм|threads|vk|вк |вконтакт|reddit|реддит|соцсет|social media|форум|forum").test(s.text) && p("post|пост|стать|article|материал|content|контент|инсайт|insight|аудитори|audience|обсужден|discussion|комментар|comment|отзыв").test(s.text)
      ? { note: "audience discussions for a text", boosts: { "insights-post": 0.55 } } : null },
  { id: "video", apply: (s) => p("video|видео|reels?|рилс|рилз|shorts|шортс|клип|clip|подкаст|podcast|ролик|vertical|вертикальн|film|фильм|youtube|ютуб").test(s.text)
    ? { note: "video material", boosts: { reels: 0.5 } } : null },
  { id: "seo", apply: (s) => p("кокон|cocoon|семантическ|semantic core|семантик|seo|сео").test(s.text)
    ? { note: "semantic cocoon or SEO", boosts: { "seo-cocoon": p("кокон|cocoon|семантическ|semantic").test(s.text) ? 0.55 : 0.3 } } : null },
  { id: "roadmap", apply: (s) => p("по очереди|поочеред|one after another|разбей\\S* (\\S+ )?на (релиз|этап)|into releases|roadmap|дорожн\\S* карт|набор\\S* требовани|set of requirements|requirements|требовани").test(s.text)
    ? { note: "large requirements to ship in parts", boosts: { "roadmap-driven": 0.45 } } : null },
  { id: "deploy", apply: (s, prior) => !prior.has("roadmap") && p("деплой|deploy|выкат|выкати|вывез\\S* (\\S+ )?на прод|раскат|на прод|в прод|на production|to production|to prod|release to prod|ship to prod").test(s.text)
    ? { note: "ship to production", boosts: { deploy: 0.55 } } : null },
  { id: "web-research", apply: (s, prior) => !["x-digest", "insights", "video", "seo", "deploy"].some((id) => prior.has(id))
    && p("поиск в интернет|поищи в интернет|найди в интернет|в интернете|search the web|web search|internet search|с источниками|with sources|источник|sources|cited|обзор|overview|survey").test(s.text)
    && !p("код|code|репозитори|repo").test(s.text) ? { note: "a question for a sourced web overview", boosts: { "web-research": 0.5 } } : null },
  { id: "security", apply: (s) => p("безопасност|уязвим|security|vulnerab|дыр\\S* в|pentest|injection|xss|csrf").test(s.text) ? { note: "security", boosts: { "security-audit": 0.5 } } : null },
  { id: "pr-review", apply: (s) => s.pr || p("pull request|merge request|diff|code review|ревью кода|review (the |this |my )?(pr|diff|changes|commit)").test(s.text)
    ? { note: s.pr ? `pull request ${s.pr}` : "review of a change", boosts: { "code-review": 0.4 } } : null },
  { id: "findings-fix", apply: (s) => p("нашел|нашла|нашли|находк|замечани|finding|critic found|reviewer (found|said)|review (found|comments)|after the review|после ревью|по ревью").test(s.text) && FIX.test(s.text)
    ? { note: "findings exist, fix and re-check", boosts: { "review-fix": 0.5 } } : null },
  { id: "quality-sweep", apply: (s) => p("качеств\\S* репозитори|quality of the (whole )?repo|общ\\S* проверк\\S* качеств|repo wide|whole repo|весь репозитори|всего репозитори|по всему проекту|across the (whole )?(repo|codebase)").test(s.text) && FIX.test(s.text)
    ? { note: "whole-repository quality sweep with fixes", boosts: { "quality-loop": 0.45 } } : null },
  { id: "plan-only", apply: (s, prior) => prior.has("read-only") && p("план|plan|распиши").test(s.text) && !p("релиз|release|roadmap|дорожн").test(s.text)
    ? { note: "a plan and nothing run", boosts: { "plan-only": 0.4 } } : null },
  { id: "grill", apply: (s) => {
    if (!p("допрос|допроси|interrogat|grill|poke holes|прижми|pressure test|stress test|раскритик|критикуй|criticiz|challenge my|punch holes|слабые места в плане|проверь мой план").test(s.text)) return null;
    const then = /(implement|build|реализ|сдела|делаем|кодим)\p{L}*[^.]{0,40}(afterward|after that|later|потом|затем|then)|(afterward|after that|потом|затем|and then)[^.]{0,40}(implement|build|реализ|сдела|делаем|кодим)/u.test(s.text);
    return { note: then ? "plan interrogation, then implementation" : "plan interrogation", boosts: then ? { "grill-driven": 0.5, "grill-plan": 0.1 } : { "grill-plan": 0.45, "grill-driven": 0.1 } };
  } },
  { id: "brainstorm", apply: (s) => p("придума|brainstorm|штурм|обсудим вариант|идея|идею|идеи|ideas?|как будет работать|варианты|explore options").test(s.text)
    ? { note: "an idea to work out first", boosts: { "brainstorm-driven": 0.4 } } : null },
  { id: "blueprint", apply: (s) => {
    const hits = ["prd", "архитектур", "эпик", "epic", "спецификац", "specification", "техзадани", "blueprint"].filter((word) => p(word).test(s.text)).length;
    return hits ? { note: "a formal spec package before code", boosts: { "blueprint-driven": hits >= 2 ? 0.55 : 0.3 } } : null;
  } },
  { id: "milestone", apply: (s) => p("этап завершен|этап закрыт|закры\\S* этап|закрытие этапа|milestone|close out|wrap up|вывод\\S* для следующ|lessons learned|сохрани вывод").test(s.text)
    ? { note: "close a milestone and keep the lessons", boosts: { "milestone-close": 0.5 } } : null },
  { id: "retro", apply: (s) => p("ретро|retro|итоги недели|за прошлую неделю").test(s.text) ? { note: "a retrospective", boosts: { retrospective: 0.5 } } : null },
  { id: "stages", apply: (s) => {
    const groups = STAGE_GROUPS.filter((rx) => rx.test(s.text)).length;
    if (p("от плана до|from plan to|полный цикл|full cycle|lifecycle|весь цикл|до приемки|until acceptance|end to end").test(s.text)) return { note: "the whole cycle is asked for", boosts: { "full-lifecycle": 0.55 } };
    return groups >= 3 ? { note: `${groups} stages named (plan, build, review, test, acceptance)`, boosts: { "full-lifecycle": 0.45 } } : null;
  } },
  { id: "tiny-edit", apply: (s, prior) => {
    if ([...prior].some((id) => id !== "ui-words")) return null;
    if (s.files.length && s.wordCount <= 14) return { note: `a short change in ${s.files[0]}`, boosts: { companion: 0.4 } };
    return s.wordCount <= 12 && p("typo|опечатк|bump|переименуй|rename|поменяй|замени").test(s.text) ? { note: "a small mechanical change", boosts: { companion: 0.2 } } : null;
  } },
  { id: "feature-work", apply: (s, prior) => {
    if (!p("добав|реализ|implement|add |create|создай|подключ|wire up|сделай|make|build|напиш|write|support|поддерж|интегрир|integrate").test(s.text)) return null;
    // Nothing more specific fired: an ordinary change to the code. Tests that come with it are part of it, and plain UI words are not a from-scratch design.
    if ([...prior].some((id) => id !== "ui-words" && id !== "read-only")) return null;
    return { note: "an ordinary code change", boosts: { "analyze-plan-execute": 0.25, "test-gen": -0.25, "impeccable-build": -0.15 } };
  } },
];

type RuleHit = { id: string; note: string; boosts: Record<string, number>; flag?: RuleOutcome["flag"] };

function applyRules(s: Signals): RuleHit[] {
  const hits: RuleHit[] = [], seen = new Set<string>();
  for (const rule of RULES) {
    const outcome = rule.apply(s, seen);
    if (!outcome) continue;
    hits.push({ id: rule.id, ...outcome });
    seen.add(rule.id);
  }
  return hits;
}

/** "Continue" is not a workflow: it is answered from the state of the run (spec 4.3, `state_continue`). */
const CONTINUE = new RegExp(`^(?:${foldSource("давай ")})?(?:${foldSource("продолж\\S*|дальше|что дальше|continue|go on|keep going|what next|next")})$`, "u");

// ------------------------------------------------------------------ the catalog index

type Doc = { workflow: Workflow; tf: Map<string, number>; len: number; exampleGrams: Array<Set<string>>; nameStems: Set<string> };
const W_NAME = 3, W_TAG = 2.5, W_DESC = 1.5, W_EXAMPLE = 1, K1 = 1.2, BM_B = 0.6;

/** The router offers, and the PM may start, only a published workflow that is not a fragment and not Lane Pilot's own per-task pipeline. */
export const isOffered = (workflow: Workflow): boolean => workflow.status === "published" && !workflow.internal && !NEVER_OFFERED.has(workflow.id);
export const isPipeline = (workflow: Workflow): boolean => NEVER_OFFERED.has(workflow.id);

function buildIndex(workflows: ReadonlyArray<Workflow>) {
  const docs: Doc[] = workflows.filter(isOffered).map((workflow) => {
    const tf = new Map<string, number>();
    let len = 0;
    const add = (text: string, weight: number) => { for (const term of stems(text)) { tf.set(term, (tf.get(term) ?? 0) + weight); len += weight; } };
    add(`${workflow.name.en} ${workflow.name.ru}`, W_NAME);
    add(workflow.tags.join(" "), W_TAG);
    add(`${workflow.description.en} ${workflow.description.ru}`, W_DESC);
    const examples = [...workflow.examples.en, ...workflow.examples.ru];
    for (const example of examples) add(example, W_EXAMPLE);
    return { workflow, tf, len, exampleGrams: examples.map((example) => grams(stems(example).join(" "))), nameStems: new Set(stems(`${workflow.name.en} ${workflow.name.ru}`)) };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const avgLen = docs.reduce((sum, doc) => sum + doc.len, 0) / Math.max(1, docs.length);
  const idf = (term: string) => Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
  return { docs, df, avgLen, idf };
}

/** The text score of one card for the request: BM25 over weighted fields plus the best trigram match against its examples, 0 to about 1. */
function baseScore(index: ReturnType<typeof buildIndex>, doc: Doc, query: string[]): number {
  const known = query.filter((term) => index.df.has(term));
  if (!known.length) return 0;
  let sum = 0, max = 0;
  // Words the catalog has never seen (the domain of the task) count a little against the match: one shared word is not a match for a long request.
  max += 0.4 * (query.length - known.length) * index.idf("") * (K1 + 1);
  for (const term of known) {
    const weight = index.idf(term), tf = doc.tf.get(term) ?? 0;
    max += weight * (K1 + 1);
    if (tf) sum += weight * (tf * (K1 + 1)) / (tf + K1 * (1 - BM_B + BM_B * doc.len / index.avgLen));
  }
  const queryGrams = grams(query.join(" "));
  const example = doc.exampleGrams.reduce((best, candidate) => Math.max(best, dice(queryGrams, candidate)), 0);
  return 0.6 * (max ? sum / max : 0) + 0.4 * Math.min(1, example * 1.6);
}

// ------------------------------------------------------------------ state checks

/** Why a workflow cannot run here, from `requires` and what the state port knows; null when nothing known forbids it. */
export function stateProblem(workflow: Workflow, state: RouterState | undefined): string | null {
  if (!state) return null;
  const { requires } = workflow;
  for (const plugin of requires.plugins) if (state.plugin?.(plugin) === false) return `plugin ${plugin} is not available`;
  for (const skill of requires.skills) if (state.skill?.(skill) === false) return `skill ${skill} is not installed`;
  for (const raw of requires.secrets) {
    // `TAVILY_API_KEY (only with research=true)` names an optional secret: it never excludes the workflow.
    const name = /^[A-Z][A-Z0-9_]+/.exec(raw)?.[0];
    if (name && !/\(|optional|по желанию|только при|only/i.test(raw) && state.secret?.(name) === false) return `secret ${name} is not set`;
  }
  for (const machine of requires.machines) if (/^host_[a-z0-9]+$/.test(machine) && state.machine?.(machine) === false) return `machine ${machine} is not available`;
  for (const [key, value] of Object.entries(requires.project ?? {})) if (value === true && state.project?.(key) === false) return `the project has no ${key}`;
  return null;
}

// ------------------------------------------------------------------ the deterministic model

/** Confidence from the top candidate's strength and its margin over the second. Rule hits make the top candidate more certain. */
export function scoreConfidence(top: number, second: number, ruleHits: number): number {
  const strength = Math.min(1, top / 0.55);
  const margin = second <= 0 ? 1 : Math.max(0, Math.min(1, (top - second) / (0.3 * top)));
  return Math.round(100 * Math.min(1, 0.4 * strength + 0.5 * margin + 0.1 * Math.min(1, ruleHits)));
}

/** The default model: no network, no randomness. It trusts the search score and the rules, so it is only as good as the catalog text. */
export const deterministicRouterModel: RouterModel = async ({ candidates }) => {
  const [first, second] = candidates;
  if (!first || first.score <= 0) return { choice: null, confidence: 0, pattern: "no candidate matches", rejected: [], questions: [] };
  const confidence = scoreConfidence(first.score, second?.score ?? 0, first.rules.length);
  return {
    choice: first.id, confidence,
    pattern: `${first.id} matches best (score ${first.score.toFixed(2)}${second ? `, next ${second.id} ${second.score.toFixed(2)}` : ""})${first.rules.length ? `; rules: ${first.rules.join(", ")}` : ""}`,
    rejected: candidates.slice(1).map((card) => ({ id: card.id, reason: `scores lower (${card.score.toFixed(2)} against ${first.score.toFixed(2)})` })),
    questions: [],
  };
};

// ------------------------------------------------------------------ the decision

export type RouteGoal = { id: string; done_when: string; evidence: string; guess?: true };
export type BoundaryContract = { in_scope: string[]; out_of_scope: string[]; constraints: string[]; guesses: string[] };
export type RouteDecision = {
  decision: "route" | "clarify";
  workflowId: string | null;
  /** On a clarify decision: the best candidate that was not trusted enough. */
  suggested: string | null;
  confidence: number;
  evidence: {
    pattern: string;
    rejected: Array<{ id: string; reason: string }>;
    rules: Array<{ id: string; note: string }>;
    model: "deterministic" | "external";
    /** True when a plugged model failed or named an id outside the candidates and the scorer decided instead. */
    modelFallback?: string;
  };
  candidates: Array<{ id: string; name: string; score: number; base: number; boost: number; penalty: number; rules: string[]; stat?: number }>;
  questions: string[];
  boundary_contract: BoundaryContract | null;
  goals: RouteGoal[];
  inputs: Record<string, unknown>;
  missingInputs: string[];
  /** Names of inputs filled by a guess from the request text (the goal copied from the intent, for example), not read from it. */
  guessedInputs: string[];
  warnings: string[];
  /** The request is «continue»: no workflow, answer from the state of the run. */
  stateContinue: boolean;
};

const cardOf = (workflow: Workflow, score: number, rules: string[]): RouterCard => ({
  id: workflow.id, name: workflow.name, description: workflow.description, examples: workflow.examples, not_for: workflow.not_for, tags: workflow.tags,
  inputs: workflow.inputs.map((field) => ({ name: field.name, type: field.type, required: field.required, ...(field.description ? { description: field.description } : {}) })),
  outputs: workflow.outputs.map((field) => ({ name: field.name, type: field.type, ...(field.description ? { description: field.description } : {}) })),
  requires: workflow.requires, score: Math.round(score * 1000) / 1000, rules,
});

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const sentence = (text: string, max = 140): string => {
  const first = text.split(/(?<=[.!?])\s/)[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

const GENERIC_QUESTIONS = {
  en: ["What exactly should be worked on (which project, page, module or file) and what should change?", "Are there constraints: what must not be touched, deadlines, approaches to avoid?", "How will we know it is done: what result should I show you?"],
  ru: ["Что именно нужно сделать и где (какой проект, страница, модуль или файл) и что должно измениться?", "Есть ли ограничения: что нельзя трогать, сроки, подходы, которых надо избегать?", "Как поймём, что готово: какой результат вам показать?"],
};

/** Up to three questions: the signal that tells the top two apart, the required inputs still missing, then scope, constraints and done-criteria. */
function questionsFor(input: { ru: boolean; broad: boolean; top: Workflow[]; missing: string[] }): string[] {
  const { ru, broad, top } = input, out: string[] = [];
  const lang = ru ? "ru" : "en";
  if (!broad && top.length >= 2) {
    const [a, b] = top as [Workflow, Workflow];
    out.push(ru ? `Что ближе к задаче: «${a.name.ru}» (${sentence(a.description.ru)}) или «${b.name.ru}» (${sentence(b.description.ru)})?`
      : `Which is closer to what you need: "${a.name.en}" (${sentence(a.description.en)}) or "${b.name.en}" (${sentence(b.description.en)})?`);
  }
  if (!broad && top[0]) {
    for (const name of input.missing.slice(0, 2)) {
      const field = top[0].inputs.find((item) => item.name === name);
      const detail = field?.description ?? field?.note;
      out.push(ru ? `Уточните «${name}»${detail ? ` (${detail})` : ""}.` : `Please give me "${name}"${detail ? ` (${detail})` : ""}.`);
    }
  }
  for (const question of GENERIC_QUESTIONS[lang]) if (out.length < MAX_QUESTIONS) out.push(question);
  return out.slice(0, MAX_QUESTIONS);
}

const TEXT_INPUTS = new Set(["goal", "question", "symptom", "topic", "query", "idea", "requirements"]);

/** What the request itself can fill: tracker ids, PR numbers, URLs and files are read from it; a free-text goal is a guess (the intent as is). */
function fillInputs(workflow: Workflow, s: Signals, intent: string): { inputs: Record<string, unknown>; missing: string[]; guessed: string[] } {
  const inputs: Record<string, unknown> = {}, guessed: string[] = [];
  for (const field of workflow.inputs) {
    const name = field.name;
    if (/^(task_ref|ticket|issue)$/.test(name) && s.ticket && field.type === "string") inputs[name] = s.ticket;
    else if (name === "pr" && s.pr) inputs[name] = field.type === "number" ? Number(s.pr) : s.pr;
    else if (/^(url|source|site_url|health_url)$/.test(name) && s.urls[0] && field.type === "string") inputs[name] = s.urls[0];
    else if (name === "post_urls" && s.urls.length && field.type === "array") inputs[name] = s.urls;
    else if (name === "files" && s.files.length && field.type === "array") inputs[name] = s.files;
    else if (TEXT_INPUTS.has(name) && field.type === "string") { inputs[name] = intent.trim(); guessed.push(name); }
  }
  const missing = workflow.inputs.filter((field) => field.required && inputs[field.name] === undefined && field.default === undefined).map((field) => field.name);
  return { inputs, missing, guessed };
}

function boundaryFor(input: { workflow: Workflow; s: Signals; intent: string; context?: string; hits: RuleHit[] }): BoundaryContract {
  const { s, hits } = input, guesses: string[] = [];
  const in_scope = [input.intent.trim().slice(0, 400), ...s.files.map((file) => `file ${file}`), ...s.urls.slice(0, 3)];
  const negations = (input.intent.match(/(?:не |без |do not |don't |never |nothing |only )[^.;!?\n]{3,120}/giu) ?? []).map((part) => part.trim());
  const out_of_scope = negations.slice(0, 3);
  const constraints: string[] = [];
  if (hits.some((hit) => hit.flag === "readonly")) { constraints.push("read-only: no file may change"); guesses.push("constraints: read-only"); }
  if (hits.some((hit) => hit.flag === "behaviour")) { constraints.push("observable behaviour must stay the same"); guesses.push("constraints: behaviour unchanged"); }
  for (const line of (input.context ?? "").split(/\n|(?<=[.!?])\s/).map((part) => part.trim()).filter(Boolean)) {
    if (constraints.length >= 5) break;
    if (/\b(must|must not|never|only|deadline|by \w+day)\b|нельзя|обязательно|только|не позже|до \d/iu.test(line)) { constraints.push(line.slice(0, 200)); guesses.push("constraints: from the context"); }
  }
  if (!out_of_scope.length) guesses.push("out_of_scope: nothing was excluded in the request");
  return { in_scope, out_of_scope, constraints, guesses };
}

function goalsFor(workflow: Workflow, intent: string): RouteGoal[] {
  const goals: RouteGoal[] = [{ id: "request", done_when: `The request is satisfied: ${intent.trim().slice(0, 200)}`, evidence: `the workflow run ends succeeded and its outputs answer the request`, guess: true }];
  // The status first, then the other declared outputs: what the run must produce is what the workflow says it produces.
  const outputs = [...workflow.outputs].sort((a, b) => Number(b.name === "status") - Number(a.name === "status") || Number(b.required) - Number(a.required));
  for (const output of outputs.slice(0, 4)) {
    goals.push({ id: output.name, done_when: `${output.name} is produced${output.description ? `: ${output.description}` : ` (${output.type})`}`, evidence: `field "${output.name}" in the output of the workflow run` });
  }
  return goals;
}

/** How a workflow has run so far (real runs only): the router's tiebreaker. */
export type RunRecord = { succeeded: number; failed: number; lastRunAt: number | null };
export type RouteInput = { intent: string; context?: string; workflows: ReadonlyArray<Workflow>; state?: RouterState; model?: RouterModel | null;
  /** Run statistics by workflow id: between candidates the text search scores (nearly) alike, the one that has run well and lately comes first. Never lets a worse text match win. */
  stats?: ReadonlyMap<string, RunRecord>; now?: number };

/** How much the run record can move a score: less than the gap between two different text matches, enough to order two that are alike. */
export const STAT_WEIGHT = 0.02;
const RECENT_MS = 30 * 24 * 3_600_000;
/** 0 to 1: the share of finished runs that succeeded (smoothed, so one lucky run is not a record), and how recent the last run is; a workflow that never ran sits in the middle. */
export function trackRecord(record: RunRecord | undefined, now: number): number {
  const finished = (record?.succeeded ?? 0) + (record?.failed ?? 0);
  const reliability = (((record?.succeeded ?? 0) + 1) / (finished + 2));
  const recency = record?.lastRunAt ? Math.exp(-Math.max(0, now - record.lastRunAt) / RECENT_MS) : 0;
  return 0.7 * reliability + 0.3 * recency;
}

export async function routeIntent(input: RouteInput): Promise<RouteDecision> {
  const intent = input.intent.trim();
  let s = signalsOf(intent);
  const empty = (partial: Partial<RouteDecision>): RouteDecision => ({
    decision: "clarify", workflowId: null, suggested: null, confidence: 0,
    evidence: { pattern: "", rejected: [], rules: [], model: "deterministic" }, candidates: [], questions: [], boundary_contract: null, goals: [], inputs: {}, missingInputs: [], guessedInputs: [], warnings: [], stateContinue: false,
    ...partial,
  });
  const lang = s.ru ? "ru" : "en";
  if (CONTINUE.test(s.text)) {
    return empty({ stateContinue: true, evidence: { pattern: "«continue» is answered from the state of the run, not by a workflow", rejected: [], rules: [{ id: "state_continue", note: "continue" }], model: "deterministic" },
      questions: [s.ru ? "Что продолжить? Посмотрите состояние прогона (lane_pilot_run_health) и предложите следующий шаг." : "Continue what? Check the run state (lane_pilot_run_health) and propose the next step."] });
  }

  const index = buildIndex(input.workflows);
  if (!index.docs.length) return empty({ evidence: { pattern: "no published workflow in the catalog", rejected: [], rules: [], model: "deterministic" } });
  let broad = s.sig.length < 2;
  let query = s.sig;
  if (broad && input.context?.trim()) {
    // A short request is read together with its context; the rules still read only what the owner said, but ids and links may come from the context.
    const withContext = signalsOf(`${intent}\n${input.context}`);
    if (withContext.sig.length >= 2) { query = withContext.sig; broad = false; s = { ...s, ticket: s.ticket ?? withContext.ticket, pr: s.pr ?? withContext.pr, urls: withContext.urls, files: withContext.files }; }
  }

  const hits = applyRules(s);
  const boost = new Map<string, number>();
  for (const hit of hits) for (const [id, value] of Object.entries(hit.boosts)) boost.set(id, (boost.get(id) ?? 0) + value);

  const base = new Map(index.docs.map((doc) => [doc.workflow.id, baseScore(index, doc, query)]));
  const before = (id: string) => (base.get(id) ?? 0) + (boost.get(id) ?? 0);
  const scored = index.docs.map((doc) => {
    // `not_for` names neighbours this card is confused with: the closer the request is to one of them (search score with its rule hits), the less this card fits.
    // An entry that is not an id is a phrase: a request close to it is not for this card.
    let penalty = 0;
    const own = before(doc.workflow.id);
    for (const entry of doc.workflow.not_for) {
      if (base.has(entry)) penalty = Math.max(penalty, 0.25 * Math.max(0, before(entry) - 0.9 * own));
      else if (entry.includes(" ") && dice(grams(stems(entry).join(" ")), grams(query.join(" "))) > 0.5) penalty = Math.max(penalty, 0.3);
    }
    const score = Math.max(0, own - penalty);
    // The run record only orders alike matches; a candidate with no text match at all keeps score 0 whatever its record.
    const rank = score + (input.stats && score > 0 ? STAT_WEIGHT * trackRecord(input.stats.get(doc.workflow.id), input.now ?? Date.now()) : 0);
    return { workflow: doc.workflow, score, rank, base: base.get(doc.workflow.id) ?? 0, boost: boost.get(doc.workflow.id) ?? 0, penalty, rules: hits.filter((hit) => (hit.boosts[doc.workflow.id] ?? 0) > 0).map((hit) => hit.id) };
  });

  const excluded: Array<{ id: string; reason: string }> = [];
  const available = scored.filter((item) => {
    const problem = stateProblem(item.workflow, input.state);
    if (problem) { excluded.push({ id: item.workflow.id, reason: problem }); return false; }
    return true;
  }).sort((a, b) => b.rank - a.rank || a.workflow.id.localeCompare(b.workflow.id));
  const top = available.slice(0, TOP_N);
  const cards = top.map((item) => cardOf(item.workflow, item.score, item.rules));
  const warnings: string[] = [];
  const bestExcluded = scored.filter((item) => excluded.some((e) => e.id === item.workflow.id)).sort((a, b) => b.score - a.score)[0];
  if (bestExcluded && bestExcluded.score > (top[0]?.score ?? 0)) warnings.push(`the closest match ${bestExcluded.workflow.id} is not available: ${excluded.find((e) => e.id === bestExcluded.workflow.id)!.reason}`);

  // The model chooses among the candidates; a failing or off-list answer falls back to the scorer, never to an unlisted id.
  const model = input.model === undefined ? pluggedModel : input.model;
  let output: RouterModelOutput | null = null, modelFallback: string | undefined;
  if (model && cards.length) {
    try {
      const answer = await model({ intent, ...(input.context ? { context: input.context } : {}), candidates: cards });
      if (answer.choice !== null && !cards.some((card) => card.id === answer.choice)) modelFallback = `model chose ${answer.choice}, which is not among the candidates`;
      else output = { ...answer, confidence: Math.max(0, Math.min(100, Math.round(Number(answer.confidence) || 0))), questions: (answer.questions ?? []).slice(0, MAX_QUESTIONS), rejected: answer.rejected ?? [] };
    } catch (cause) { modelFallback = `model failed: ${cause instanceof Error ? cause.message : String(cause)}`; }
  }
  const usedModel = Boolean(output);
  output ??= await deterministicRouterModel({ intent, candidates: cards });

  const record = (pattern: string, rejected: Array<{ id: string; reason: string }>): RouteDecision["evidence"] => ({
    pattern, rejected: [...rejected, ...excluded.filter((e) => !rejected.some((r) => r.id === e.id))],
    rules: hits.map((hit) => ({ id: hit.id, note: hit.note })), model: usedModel ? "external" : "deterministic", ...(modelFallback ? { modelFallback } : {}),
  });
  const candidates = top.map((item, i) => ({ id: item.workflow.id, name: item.workflow.name[lang], score: cards[i]!.score, base: round3(item.base), boost: round3(item.boost), penalty: round3(item.penalty), rules: item.rules,
    ...(input.stats ? { stat: round3(trackRecord(input.stats.get(item.workflow.id), input.now ?? Date.now())) } : {}) }));
  const chosen = output.choice ? top.find((item) => item.workflow.id === output!.choice)?.workflow ?? null : null;

  // Too weak, too broad, or no choice: questions, no workflow.
  const strongRule = hits.some((hit) => Object.values(hit.boosts).some((value) => value >= 0.3));
  if (!chosen || output.confidence < MIN_CONFIDENCE || (broad && !strongRule) || (top[0]?.score ?? 0) < 0.12) {
    const modelQuestions = output.questions.filter((question) => question.trim());
    const filled = chosen ? fillInputs(chosen, s, intent) : null;
    const questions = modelQuestions.length ? modelQuestions.slice(0, MAX_QUESTIONS)
      : questionsFor({ ru: s.ru, broad: broad || (top[0]?.score ?? 0) < 0.12, top: top.slice(0, 2).map((item) => item.workflow), missing: filled?.missing ?? [] });
    return empty({ confidence: Math.min(output.confidence, MIN_CONFIDENCE - 1), suggested: chosen?.id ?? null, evidence: record(output.pattern, output.rejected), candidates, questions, warnings });
  }

  const filled = fillInputs(chosen, s, intent);
  if (chosen.id === "milestone-close" && (input.state?.openTasks?.() ?? 0) > 0) warnings.push(`${input.state!.openTasks!()} tasks of this run are still open: close the milestone only after they finish`);
  return empty({
    decision: "route", workflowId: chosen.id, confidence: output.confidence, evidence: record(output.pattern, output.rejected), candidates, warnings,
    boundary_contract: boundaryFor({ workflow: chosen, s, intent, context: input.context, hits }), goals: goalsFor(chosen, intent),
    inputs: filled.inputs, missingInputs: filled.missing, guessedInputs: filled.guessed,
  });
}
