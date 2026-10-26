/**
 * Does a prompt name every word its validator demands? A model fails a check again and again when its instructions never
 * say one of the accepted values (an enum member, an exact marker). This compares a vocabulary with the instruction texts
 * the model is given and lists what is missing. Ported from Matvey Maslov's `prompt-covers-schema` (MIT), narrowed to
 * string literals; patterns and required property names are not audited.
 *
 * Matching is literal. A word character is a letter, mark, number, connector punctuation (`_`) or a join control; the
 * literal must have none directly before or after it, so `failed` and `fail_safe` do not name `fail`, while `(fail)` does.
 * Hyphens separate words. Texts are normalized to NFC with LF line ends and are examined one by one, so the end of one
 * cannot join the start of the next. Case counts unless `ignoreCase` is set (Unicode simple folding).
 */
const WORD = "[\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200c\\u200d]";
const normalize = (text: string) => text.replace(/\r\n?/g, "\n").normalize("NFC");
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type CoverageOptions = { ignoreCase?: boolean };
export type LiteralCoverage = { mentioned: string[]; missing: string[]; partial: boolean };

/** Which of `literals` are named by at least one of `texts`; `partial` when some are named and some are not. */
export function literalCoverage(literals: readonly string[], texts: string | readonly string[], options: CoverageOptions = {}): LiteralCoverage {
  const haystacks = (typeof texts === "string" ? [texts] : texts).map(normalize);
  const flags = options.ignoreCase ? "iu" : "u";
  const mentioned: string[] = [], missing: string[] = [];
  for (const literal of literals) {
    const matcher = new RegExp(`(?<!${WORD})${escapeRegex(normalize(literal))}(?!${WORD})`, flags);
    (haystacks.some((text) => matcher.test(text)) ? mentioned : missing).push(literal);
  }
  return { mentioned, missing, partial: mentioned.length > 0 && missing.length > 0 };
}

export type EnumGroup = { path: string; values: string[] };
export type EnumCoverage = EnumGroup & LiteralCoverage;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const escapePointer = (key: string | number) => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * The string `enum` and `const` values of a JSON Schema, one group per enum, with the JSON Pointer of each. Walks `properties`,
 * `items`, `anyOf`, `oneOf`, `allOf` and local `$ref`s; every alternative and optional property counts, because the aim is to
 * name the whole vocabulary before the model answers. A definition is reported once, at its first path.
 */
export function schemaEnums(schema: unknown): EnumGroup[] {
  const groups: EnumGroup[] = [], seen = new Set<unknown>();
  const walk = (node: unknown, path: string) => {
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    const strings = (list: unknown[]) => list.filter((value): value is string => typeof value === "string" && value !== "");
    if (Array.isArray(node.enum)) { const values = strings(node.enum); if (values.length) groups.push({ path: `${path}/enum`, values }); }
    if (typeof node.const === "string" && node.const !== "") groups.push({ path: `${path}/const`, values: [node.const] });
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      const target = node.$ref.slice(2).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~")).reduce<unknown>((at, key) => (isObject(at) ? at[key] : undefined), schema);
      walk(target, node.$ref);
    }
    if (isObject(node.properties)) for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}/properties/${escapePointer(name)}`);
    if (Array.isArray(node.items)) node.items.forEach((child, index) => walk(child, `${path}/items/${index}`));
    else walk(node.items, `${path}/items`);
    for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[key])) (node[key] as unknown[]).forEach((child, index) => walk(child, `${path}/${key}/${index}`));
  };
  walk(schema, "#");
  return groups;
}

/** `schemaEnums` of a schema, each group checked against the texts. */
export function enumCoverage(schema: unknown, texts: string | readonly string[], options: CoverageOptions = {}): EnumCoverage[] {
  return schemaEnums(schema).map((group) => ({ ...group, ...literalCoverage(group.values, texts, options) }));
}
