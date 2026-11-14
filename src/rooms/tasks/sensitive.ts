/**
 * The three classes the owner's word is asked for on owner.words = `sensitive` (the default since 0.1.556; the owner's decision of 2026-11-14,
 * once high-risk tasks got a strong plan critic, a strict code critic and a cross-family verifier of high findings):
 *   money    payments, billing, prices, refunds, payouts;
 *   data     database migrations, schema changes, destructive data operations;
 *   deploy   a deploy or release to production (live; not staging, a preview, a sandbox or the drill).
 * Everything else lands by the machine's gates, whatever its risk: «deploy» in a task text alone, a refactor of risk high, auth or secrets
 * work do not ask.
 *
 * Evidence, strongest first: the changed paths (the files the attempt produced, else owns_paths), the check commands (verification), the
 * task's own text (title, display_title, objective). A path counts when its name says the class (src/billing/, a migrations/ folder, a
 * *.sql or schema.prisma file, a deploy workflow); a command counts when it does the thing (prisma migrate deploy, DROP TABLE, pm2 reload
 * on a production target); the text counts only as a phrase (not a bare word) and only when the task changes something beyond docs, tests,
 * styles and images. A test or docs file never counts by its name.
 * The path patterns are shared with the code critic's sensitive-path rule (critique/critic-level.ts), which adds auth, secrets and the rest.
 */

/** Money by path: payments, billing, invoices, checkout, refunds, payouts, the payment providers, wallets, prices. */
export const MONEY_PATH = /(^|[/._-])(payment|payments|billing|invoice|invoices|checkout|refund|refunds|payout|payouts|stripe|yookassa|cloudpayments|wallet|money|price|pricing)([/._-]|$)/i;
/** Data by path: migrations, SQL files, schema files of the common ORMs and migration tools. */
export const DATA_PATH = /(^|[/._-])(migration|migrations)([/._-]|$)|\.sql$|(^|\/)schema\.(prisma|rb)$|(^|\/)(prisma\/schema|drizzle|alembic|db\/migrate|flyway)(\/|\.|$)/i;
/** The production release pipeline by path: a deploy / release / publish workflow, the pm2 ecosystem file (what main runs in production). */
export const DEPLOY_PIPELINE_PATH = /(^|\/)\.github\/workflows\/[^/]*(deploy|release|publish|prod)[^/]*$|(^|\/)ecosystem\.config\.[cm]?[jt]s$/i;
/** A deploy-named file (script, folder): it counts only next to a production marker in the task's commands or text. */
const DEPLOY_NAMED_PATH = /(^|[/._-])(deploy|deployment|release)([/._-]|$)/i;

export const DOCS_OR_TEST_PATH = /\.(md|mdx|rst)$|(^|\/)docs\/|(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/i;
const STYLE_OR_ASSET_PATH = /\.(css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?)$/i;

export type SensitiveClass = "money" | "data" | "deploy";
export type SensitiveHit = { cls: SensitiveClass; evidence: string };
/** What a step is made of: the files it changes, the commands it runs, and its text. A step with no files (a permit, a phase) passes commands or text. */
export type StepEvidence = { paths?: readonly string[]; commands?: readonly string[]; text?: readonly (string | null | undefined)[]; /** Work of kind docs, research or check: its text is about something, not a change. */ describesOnly?: boolean };

const PRODUCTION = /\b(prod|production|live|prd)\b|прод(акшен)?(?![а-яё])|боев(ой|ом|ое|ого)/i;
/** What a command names when it targets something that is not production. */
const STAGING_ONLY = /\b(stag(e|ing)|preview|sandbox|drill|dry[- ]?run|local|dev(elopment)?)\b/i;
const NOT_PRODUCTION = /\b(stag(e|ing)|preview|sandbox|drill|dry[- ]?run|local|dev(elopment)?|test(ing)?|qa)\b|стейдж|песочниц|тестов|локальн/i;
const NEGATED = /\b(no|not|never|without|don'?t|do not|except)\b[^.\n]{0,40}\b(deploy|release|publish|prod|production|live)\b|(^|[^а-яё])не\s+[^.\n]{0,30}(деплои|выкат|релиз|прод)/i;

/** A command that does the thing: it runs a migration, drops data, charges or refunds money, or deploys to a production target. */
const DATA_COMMAND: readonly RegExp[] = [
  /\b(prisma\s+(migrate\s+(deploy|dev|reset)|db\s+(push|execute)))\b/i,
  /\b(drizzle-kit\s+(push|migrate)|knex\s+migrate:(latest|up|rollback)|sequelize(-cli)?\s+db:(migrate|drop)|typeorm\s+(migration:run|schema:(sync|drop))|alembic\s+(upgrade|downgrade)|rails\s+db:(migrate|drop|reset)|flyway\s+migrate|goose\s+(up|down|reset)|sqlx\s+migrate\s+run|php\s+artisan\s+migrate|django-admin\s+migrate|manage\.py\s+(migrate|flush))\b/i,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|COLUMN|INDEX|VIEW)\b|\bTRUNCATE\s+[\"\w]|\bALTER\s+TABLE\b|\bDELETE\s+FROM\b/i,
  /\b(dropdb|pg_restore|mongorestore|redis-cli\s+(flushall|flushdb))\b/i,
  /\brm\s+(-\w+\s+)*[^;&|\n]*((^|[/\s._-])(data|db|database|backups?|dumps?|uploads|volumes?|pgdata)([/\s._-]|$)|\.(sqlite3?|db)\b)/i,
];
const MONEY_COMMAND = /\bstripe\s+(charges|refunds|payouts|payment_intents)\s+(create|capture|cancel)\b|\b(refund|payout|charge)[\w:.-]*\s+--(live|prod|production)\b|\/(refunds?|payouts?|charges?)\b.*\b(POST|-X\s*POST)\b/i;
const DEPLOY_COMMAND: readonly RegExp[] = [
  /\bpm2\s+(reload|restart|deploy|start)\b/i,
  /\b(deploy|release|publish|ship)[\w:.-]*\b[^;&|\n]*\b(prod|production|live)\b|\b(prod|production|live)[\w:.-]*\b[^;&|\n]*\b(deploy|release)\b/i,
  /\bnpm\s+run\s+(deploy|release)\b/i,
  /\b(kubectl\s+(apply|rollout|set\s+image)|terraform\s+apply|helm\s+(upgrade|install)|fly\s+deploy|vercel\s+(deploy\s+)?--prod|netlify\s+deploy\s+--prod|eas\s+(submit|update)\b[^;&|\n]*\bproduction)\b/i,
  /\bgit\s+push\b[^;&|\n]*\b(production|prod|deploy)\b/i,
];

/** Phrases (not bare words) that say a task changes money, data or the production release. Checked on the title, display_title and objective only. */
const MONEY_TEXT = /\b(payments?|billing|refunds?|payouts?|checkout|invoicing|chargebacks?)\b|\b(charge|bill)\s+(the\s+)?(customers?|users?|cards?)\b|\b(change|set|update|raise|lower|increase|decrease|fix|recalculate)\b[^.\n]{0,40}\b(prices?|pricing|tariffs?)\b|\b(prices?|pricing|tariffs?)\b[^.\n]{0,30}\b(change|update|raise|lower|increase|decrease|recalculat\w*)\b|оплат[аыуе](?![а-яё])|платеж|платёж|биллинг|возврат\w*\s+(средств|денег|платеж)|выплат|эквайринг|(измен|обнов|повыс|сниз|постав|пересчит)\w*[^.\n]{0,40}(цен[ауыеой](?![а-яё])|тариф|стоимост)|(цен[ауыеой](?![а-яё])|тариф\w*|стоимост\w*)[^.\n]{0,30}(измен|обнов|повыс|сниз|пересчит)/i;
const DATA_TEXT = /\b(database|db|schema)\s+(migrations?|changes?)\b|\bmigrat(e|ion|ions)\b[^.\n]{0,40}\b(database|db|table|tables|column|columns|schema|data)\b|\b(alter|add|drop|rename)\s+(a\s+|the\s+)?(table|column|index)\b|\b(drop|truncate)\s+(table|column|database|schema)\b|\bdelete\s+from\b|\b(backfill|purge|wipe|bulk[- ]delete)\b[^.\n]{0,40}\b(data|table|rows|records|database)\b|миграци[яюиейм]\s+(бд|баз|данн|схем|таблиц)|(схем[аыуе]|таблиц[аыуе]|колонк[аиу])\s+(бд|баз)|удал\w+\s+(данных|записей|таблиц)\s+(из|в)\s+(бд|баз|прод)/i;

const textOf = (rows: readonly (string | null | undefined)[] | undefined): string => (rows ?? []).filter((row): row is string => typeof row === "string" && row.length > 0).join("\n");

/** Does the text say a deploy or release to production (a production marker, no staging-only reading, not negated)? */
export function productionDeployText(text: string): boolean {
  if (!text || NEGATED.test(text)) return false;
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (!/\b(deploy|deployment|release|publish|ship|roll\s?out|go\s+live|launch)\w*\b|деплой|деплои|выкат|релиз|выпуст/i.test(sentence)) continue;
    if (PRODUCTION.test(sentence) && !(NOT_PRODUCTION.test(sentence) && !/\b(prod|production)\b|прод(акшен)?(?![а-яё])|боев/i.test(sentence))) return true;
  }
  return false;
}

/** The classes a step falls in, each with the evidence that put it there (empty: nothing here asks the owner). */
export function sensitiveHits(step: StepEvidence): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  const add = (cls: SensitiveClass, evidence: string) => { if (!hits.some((hit) => hit.cls === cls)) hits.push({ cls, evidence }); };
  const paths = (step.paths ?? []).map((path) => path.replace(/^\.\//, ""));
  const commands = step.commands ?? [];
  const text = textOf(step.text);

  const real = paths.filter((path) => !DOCS_OR_TEST_PATH.test(path));
  for (const path of real) {
    if (MONEY_PATH.test(path)) add("money", `path:${path}`);
    if (DATA_PATH.test(path)) add("data", `path:${path}`);
    if (DEPLOY_PIPELINE_PATH.test(path)) add("deploy", `path:${path}`);
  }
  for (const command of commands) {
    if (DATA_COMMAND.some((pattern) => pattern.test(command))) add("data", `command:${command.slice(0, 120)}`);
    if (MONEY_COMMAND.test(command)) add("money", `command:${command.slice(0, 120)}`);
    if (!(STAGING_ONLY.test(command) && !PRODUCTION.test(command)) && DEPLOY_COMMAND.some((pattern) => pattern.test(command))) add("deploy", `command:${command.slice(0, 120)}`);
  }
  // A deploy-named file or the like says production only next to a production marker.
  const productionNamed = real.find((path) => DEPLOY_NAMED_PATH.test(path));
  if (productionNamed && (productionDeployText(text) || commands.some((command) => PRODUCTION.test(command)))) add("deploy", `path:${productionNamed}`);

  // The text is a weak witness: only for work that changes something beyond docs, tests, styles and images.
  const touchesLogic = paths.length === 0 || paths.some((path) => !DOCS_OR_TEST_PATH.test(path) && !STYLE_OR_ASSET_PATH.test(path));
  if (text && touchesLogic && !step.describesOnly) {
    const money = MONEY_TEXT.exec(text);
    if (money) add("money", `text:${money[0].slice(0, 80)}`);
    const data = DATA_TEXT.exec(text);
    if (data) add("data", `text:${data[0].slice(0, 80)}`);
    if (productionDeployText(text)) add("deploy", "text:production deploy");
  }
  return hits;
}

/** The evidence of a task contract at the landing (`produced`: the files the attempt changed) or at dispatch (none yet: owns_paths). */
export function taskStepEvidence(task: { title?: string; display_title?: string; objective?: string; kind?: string; owns_paths?: readonly string[]; verification?: readonly { command: string }[] }, produced?: readonly string[]): StepEvidence {
  return {
    paths: produced && produced.length ? produced : task.owns_paths ?? [],
    commands: (task.verification ?? []).map((check) => check.command),
    text: [task.title, task.display_title, task.objective],
    describesOnly: task.kind === "docs" || task.kind === "research" || task.kind === "check",
  };
}
