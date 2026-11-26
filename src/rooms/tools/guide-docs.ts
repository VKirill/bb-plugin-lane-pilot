import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { frontValue, type ExplainDoc } from "./models/explain";

export function guideDocs(root: string): ExplainDoc[] {
  const dir = join(root, "docs", "guide");
  const docs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  return docs.sort().map((file) => { const text = readFileSync(join(dir, file), "utf8"); return { file: `docs/guide/${file}`, text, topic: frontValue(text, "topic") }; });
}
