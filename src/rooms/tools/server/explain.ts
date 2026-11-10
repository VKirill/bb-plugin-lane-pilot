import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** `bb lane-pilot explain <word>` (SMA k_v_explain): a CLI verb answers with its registry summary and usage plus the
 *  doc that names it; a topic answers with the guide doc whose front matter says `topic: <word>`. */
export type ExplainDoc = { file: string; text: string; topic: string | null };
export type ExplainHit = { kind: "verb" | "topic"; title: string; text: string; source: string | null };

const FRONT = /^---\n([\s\S]*?)\n---\n/;
/** Scalar `key: value` pairs of the front matter; the docs' explain front matter carries only those. */
export function frontValue(text: string, key: string): string | null {
  const head = text.match(FRONT)?.[1] ?? "";
  return head.match(new RegExp(`^${key}:\\s*(\\S.*)$`, "m"))?.[1]?.trim() ?? null;
}

/** The doc's first section: the title and the body up to the first `##` heading. */
export function firstSection(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(FRONT, "").trim().split("\n")) { if (out.length && /^##\s/.test(line)) break; out.push(line); }
  return out.join("\n").trim();
}

export function guideDocs(root: string): ExplainDoc[] {
  const dir = join(root, "docs", "guide");
  const docs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  return docs.sort().map((file) => { const text = readFileSync(join(dir, file), "utf8"); return { file: `docs/guide/${file}`, text, topic: frontValue(text, "topic") }; });
}

/** A verb explains itself by its registry line; the doc that names it is the first guide doc containing the verb's
 *  command name. A topic explains by its doc's first section. */
export function explainWord(word: string, verbs: ReadonlyArray<{ name: string; summary: string; usage: string }>, docs: readonly ExplainDoc[]): ExplainHit | null {
  const verb = verbs.find((v) => v.name === word || v.name.replace(/-/g, "") === word.replace(/-/g, ""));
  if (verb) {
    const named = docs.find((doc) => doc.text.includes(`lane-pilot ${verb.name}`) || doc.text.includes(`\`${verb.name}\``));
    return { kind: "verb", title: verb.name, text: `${verb.summary}\n${verb.usage}`, source: named?.file ?? null };
  }
  const doc = docs.find((doc) => doc.topic === word) ?? docs.find((doc) => doc.topic !== null && doc.topic!.replace(/\s+/g, "-") === word);
  return doc ? { kind: "topic", title: doc.topic ?? word, text: firstSection(doc.text), source: doc.file } : null;
}

/** The explain catalog (SMA k_lib_explain): every verb name and every declared topic, for an unknown word. */
export function explainCatalog(verbs: ReadonlyArray<{ name: string }>, docs: readonly ExplainDoc[]): string[] {
  return [...verbs.map((v) => v.name), ...docs.filter((doc) => doc.topic !== null).map((doc) => doc.topic!)].sort();
}
