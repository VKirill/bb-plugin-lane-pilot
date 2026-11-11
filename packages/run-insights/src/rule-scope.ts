export function parseScope(json: string | null | undefined): string[] {
  try { const value = JSON.parse(json ?? "[]") as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

const SECTION_ID = /^section:[A-Za-z0-9_.:-]{1,80}$/;

/** A file path, or a `path:` marker. A bare label such as a repo name is neither, so a new scope cannot be one. */
export function isPathSelector(entry: string): boolean {
  const path = entry.startsWith("path:") ? entry.slice("path:".length) : entry;
  return path.length > 0 && (/[\\/]/.test(path) || /\.[a-z0-9]{1,8}$/i.test(path));
}

/** Section ids, file paths, and leftover labels that match no run chain. A leftover label is not turned into "the whole project". */
export function splitRuleScope(scope: readonly string[]): { sectionChain: string[]; pathSelectors: string[]; legacy: string[] } {
  const sectionChain: string[] = [];
  const pathSelectors: string[] = [];
  const legacy: string[] = [];
  for (const entry of scope) {
    if (entry.startsWith("section:")) sectionChain.push(entry);
    else if (entry.startsWith("path:") || isPathSelector(entry)) pathSelectors.push(entry.startsWith("path:") ? entry.slice("path:".length) : entry);
    // A stored label with no colon is a folder name (`verification`), not a section. New scopes still cannot be one (`assertRuleScope`).
    else if (!entry.includes(":")) pathSelectors.push(entry);
    else legacy.push(entry);
  }
  return { sectionChain, pathSelectors, legacy };
}

/**
 * The section chain must be a prefix of the run's (its own section and everything below it; empty chain: the whole project).
 * Path selectors apply only when the task owns that file. A legacy label matches nothing: it is not widened to every section.
 */
export function scopeApplies(ruleScope: readonly string[], runChain: readonly string[], paths?: readonly string[]): boolean {
  const split = splitRuleScope(ruleScope);
  if (split.legacy.length) return false;
  const sectionOk = split.sectionChain.length <= runChain.length && split.sectionChain.every((section, index) => runChain[index] === section);
  if (!sectionOk) return false;
  if (!split.pathSelectors.length) return true;
  if (!paths?.length) return false;
  return split.pathSelectors.some((selector) => paths.some((path) => path === selector || path.endsWith(`/${selector}`) || path.includes(`/${selector}/`)));
}

/** New scopes are section ids or file paths. A label that is neither is rejected here; stored rows are not rewritten. */
export function assertRuleScope(scope: readonly string[]): string[] {
  const stored: string[] = [];
  for (const raw of scope) {
    const entry = raw.trim();
    if (!entry) continue;
    if (SECTION_ID.test(entry)) { stored.push(entry); continue; }
    if (isPathSelector(entry)) {
      const path = entry.startsWith("path:") ? entry.slice("path:".length) : entry;
      if (!path) throw new Error("rule scope path is empty");
      stored.push(`path:${path}`);
      continue;
    }
    throw new Error(`rule scope entry is neither a section id nor a path: ${entry}`);
  }
  return stored;
}
