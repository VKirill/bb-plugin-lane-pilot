import type { NodeExecutor, WorkflowEngine } from "../workflow";
import type { ServerCore } from "../core/server";
import type { ChainRuntime } from "../workflow/server";
import type { Hub } from "./hub";
import type { Section } from "./whoami";

/**
 * The two actions of the chains `about-site`, `resume` and `year-review` (A8). The chains work only from what the owner marked
 * `public` **and** confirmed: `anamnesis.public` asks the owner's machine for «who am I» with `publicOnly`, drafts excluded, so the
 * agent that writes the page never sees a private or sensitive record, a draft or a candidate. `anamnesis.check` is code on the
 * result: the page may not carry a link or an e-mail address that the facts do not contain, nor a leftover draft mark.
 */
type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export type PublicView = "site" | "resume" | "year";
const VIEWS: Record<PublicView, { sections: Section[]; detail: "normal" | "full" }> = {
  site: { sections: ["identity", "skills", "projects", "interests", "tools"], detail: "normal" },
  resume: { sections: ["identity", "skills", "projects", "timeline", "tools"], detail: "full" },
  year: { sections: [], detail: "normal" },
};

/** The public, confirmed facts for a view; `empty` when the owner has marked nothing. */
export async function publicFacts(hub: Pick<Hub, "ask">, view: PublicView, year?: number): Promise<{ text: string; records: number; empty: boolean }> {
  const shape = VIEWS[view];
  const wanted = view === "year" ? (Number.isInteger(year) && year! >= 2000 ? year : new Date().getUTCFullYear()) : undefined;
  const result = await hub.ask({ op: "whoami", publicOnly: true, includeDrafts: false, detail: shape.detail,
    ...(shape.sections.length ? { sections: shape.sections } : {}), ...(wanted !== undefined ? { year: wanted } : {}) });
  return { text: result.text, records: result.included, empty: result.included === 0 };
}

const URL_RE = /https?:\/\/[^\s)>\]"'«»<]+/gi;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const norm = (value: string): string => value.toLowerCase().replace(/[.,;:!?]+$/, "").replace(/\/+$/, "");
export const MAX_ARTIFACT = 60_000;

/** What is wrong with a page written from `facts`: empty, too long, a link or address that the facts do not have, a draft mark. */
export function checkArtifact(artifact: string, facts: string): string[] {
  const violations: string[] = [];
  if (!artifact.trim()) return ["empty_artifact"];
  if (artifact.length > MAX_ARTIFACT) violations.push(`too_long:${artifact.length}`);
  const known = new Set([...facts.matchAll(URL_RE), ...facts.matchAll(EMAIL_RE)].map((match) => norm(match[0])));
  for (const match of artifact.matchAll(URL_RE)) {
    const url = norm(match[0]);
    // A link inside the page's own markup (a stylesheet, a fragment) is not a claim; any other address must come from the facts.
    if (!known.has(url) && !/^https?:\/\/(?:www\.)?(?:w3\.org|schema\.org)\b/.test(url)) violations.push(`url_unknown:${url.slice(0, 80)}`);
  }
  for (const match of artifact.matchAll(EMAIL_RE)) if (!known.has(norm(match[0]))) violations.push(`email_unknown:${norm(match[0]).slice(0, 60)}`);
  if (/\[draft\]/i.test(artifact)) violations.push("draft_mark");
  return [...new Set(violations)];
}

export function registerAnamnesisActions(engine: WorkflowEngine, ctx: ServerCore, hubOf: (ctx: ServerCore) => Pick<Hub, "ask">): void {
  engine.register<ChainRuntime>("anamnesis.public", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const params = c.template(node.params) as Row;
      const view = text(params.view) as PublicView;
      if (!(view in VIEWS)) throw new Error(`anamnesis.public: view must be site, resume or year (got "${view}")`);
      const year = Number(params.year);
      return { output: await publicFacts(hubOf(ctx), view, Number.isFinite(year) ? year : undefined) };
    },
  } as NodeExecutor<ChainRuntime>);
  engine.register<ChainRuntime>("anamnesis.check", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const params = c.template(node.params) as Row;
      const violations = checkArtifact(text(params.artifact), text(params.facts));
      return { output: { ok: violations.length === 0, violations } };
    },
  } as NodeExecutor<ChainRuntime>);
}
