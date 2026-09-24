import { createHash } from "node:crypto";

export const DOCS_SINCE_CHOICES = ["yesterday", "24 hours ago", "7 days ago"] as const;
export type DocsSince = (typeof DOCS_SINCE_CHOICES)[number];

export type DocsMaintenanceSettings = {
  enabled: boolean;
  maintain: boolean;
  since: DocsSince;
  pageCap: number;
  hour: number;
};

export type DocsPage = { path:string; modifiedAt:number; sha256:string; content:string };
export type DocsEdit = { path:string; expectedSha256:string; content:string };

const DOC_ROOTS = ["docs/", "apps/"] as const;
const MAX_PAGE_BYTES = 40_000;

export function parseDocsSettings(raw:Record<string,unknown>):DocsMaintenanceSettings {
  const enabled = parseBoolean(raw["docs.enabled"], false, "docs.enabled");
  const maintain = parseBoolean(raw["docs.maintain"], true, "docs.maintain");
  const sinceValue = raw["docs.since"] ?? "yesterday";
  if (!(DOCS_SINCE_CHOICES as readonly unknown[]).includes(sinceValue)) throw new Error("docs.since must be yesterday, 24 hours ago, or 7 days ago");
  const pageCap = parseInteger(raw["docs.page_cap"], 0, 0, Number.MAX_SAFE_INTEGER, "docs.page_cap");
  const hour = parseInteger(raw["docs.hour"], 5, 0, 23, "docs.hour");
  return { enabled, maintain, since:sinceValue as DocsSince, pageCap, hour };
}

function parseBoolean(value:unknown, fallback:boolean, name:string):boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === 0 || value === "0" || value === "false" || value === "off" || value === "no") return false;
  throw new Error(`${name} must be a boolean`);
}

function parseInteger(value:unknown, fallback:number, min:number, max:number, name:string):number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

export function docsSinceEpoch(since:DocsSince, now:Date):number {
  if (since === "24 hours ago") return now.getTime() - 24 * 60 * 60 * 1000;
  if (since === "7 days ago") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return yesterday.getTime();
}

export function docsScheduleDue(now:Date, hour:number, lastRunDate:string|null):boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("docs.hour must be an integer from 0 to 23");
  if (now.getHours() !== hour) return false;
  return lastRunDate !== localDateKey(now);
}

export function localDateKey(date:Date):string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function selectDocsPages(pages:DocsPage[], since:DocsSince, pageCap:number, now = new Date()):{pages:DocsPage[]; sinceEpoch:number; truncated:boolean} {
  if (!Number.isSafeInteger(pageCap) || pageCap < 0) throw new Error("docs.page_cap must be a non-negative safe integer");
  const sinceEpoch = docsSinceEpoch(since, now);
  const eligible = pages.filter((page) => isDocsPath(page.path) && page.modifiedAt >= sinceEpoch && validPage(page))
    .sort((a,b) => a.path.localeCompare(b.path));
  const selected = pageCap === 0 ? eligible : eligible.slice(0, pageCap);
  return { pages:selected, sinceEpoch, truncated:selected.length < eligible.length };
}

export function validateDocsEdits(raw:unknown, selected:DocsPage[], pageCap:number):DocsEdit[] {
  if (!Array.isArray(raw)) throw new Error("docs output must be an array of edits");
  const allowed = new Map(selected.map((page) => [page.path, page.sha256]));
  if (pageCap > 0 && raw.length > pageCap) throw new Error("docs output exceeds docs.page_cap");
  const seen = new Set<string>();
  const edits:DocsEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("docs edit must be an object");
    const edit = item as Record<string,unknown>;
    if (Object.keys(edit).some((key) => !["path","expectedSha256","content"].includes(key))) throw new Error("docs edit contains unsupported fields");
    if (typeof edit.path !== "string" || !isDocsPath(edit.path)) throw new Error("docs edit path must be under docs/ or apps/");
    if (seen.has(edit.path)) throw new Error(`duplicate docs edit path: ${edit.path}`);
    seen.add(edit.path);
    const expectedSha256 = allowed.get(edit.path);
    if (!expectedSha256) throw new Error(`docs edit is outside the since/page-cap input set: ${edit.path}`);
    if (edit.expectedSha256 !== expectedSha256) throw new Error(`docs edit hash does not match observed input: ${edit.path}`);
    if (typeof edit.content !== "string" || Buffer.byteLength(edit.content, "utf8") > MAX_PAGE_BYTES) throw new Error(`docs edit content is invalid or too large: ${edit.path}`);
    edits.push({ path:edit.path, expectedSha256, content:edit.content });
  }
  return edits;
}

export function docsInputHash(pages:DocsPage[]):string {
  return createHash("sha256").update(JSON.stringify(pages.map(({path,modifiedAt,sha256}) => ({path,modifiedAt,sha256}))), "utf8").digest("hex");
}

export function docsMaintenancePrompt(input:{since:DocsSince; pages:DocsPage[]; pageCap:number; agent?:string}):string {
  return [
    `${input.agent?.trim() || "Documentation maintainer"}: maintain only the documentation pages included below. Return JSON: an array of {path, expectedSha256, content} edits; an unchanged page needs no edit.`,
    "Do not edit source, settings, memory, or any path outside docs/ and apps/. Do not invent facts or line references. Do not commit or publish.",
    `Since window: ${input.since}. Page cap: ${input.pageCap === 0 ? "unlimited" : input.pageCap}.`,
    ...input.pages.map((page) => `\n### ${page.path} (sha256 ${page.sha256})\n${page.content}`),
  ].join("\n");
}

function isDocsPath(path:string):boolean {
  return !path.startsWith("/") && !path.split(/[\\/]/).some((part) => part === ".." || part === ".")
    && DOC_ROOTS.some((root) => path.startsWith(root)) && /\.md$/i.test(path);
}

function validPage(page:DocsPage):boolean {
  return Number.isSafeInteger(page.modifiedAt) && page.modifiedAt >= 0
    && /^[a-f0-9]{64}$/.test(page.sha256) && typeof page.content === "string"
    && Buffer.byteLength(page.content, "utf8") <= MAX_PAGE_BYTES;
}
