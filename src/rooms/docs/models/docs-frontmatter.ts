export type Frontmatter = Record<string, string | string[]>;

/**
 * The YAML subset the contract uses: scalars, `[a, b]` lists and `- item` lists, indented or not. YAML allows a list
 * under a key at the key's own indent (PyYAML writes it so); read as empty, such a page was "missing tags" every night
 * while the agent's YAML parser saw them, so the pass never landed (treba, 2026-10-15..17).
 */
export function parseFrontmatter(content:string): { data:Frontmatter; body:string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return null;
  const data:Frontmatter = {};
  let listKey:string | null = null;
  const lines = match[1]!.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(raw);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1]!)); continue; }
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!field) continue;
    const [, key, value] = field as unknown as [string, string, string];
    // A block scalar (`key: >` folds its indented lines into one, `key: |` keeps the line breaks) is how a
    // long description is written; read as the bare ">" it looked like an empty value and every check on it failed.
    const block = /^([|>])[+-]?\d*$/.exec(value.trim());
    if (block) {
      const collected:string[] = [];
      while (index + 1 < lines.length && (/^[ \t]/.test(lines[index + 1]!) || lines[index + 1]!.trim() === "")) collected.push(lines[++index]!.trim());
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      data[key] = block[1] === ">" ? foldBlockScalar(collected) : collected.join("\n");
      listKey = null;
      continue;
    }
    if (value === "") { data[key] = []; listKey = key; continue; }
    listKey = null;
    const inline = /^\[(.*)\]$/.exec(value.trim());
    data[key] = inline ? inline[1]!.split(",").map((part) => unquote(part.trim())).filter(Boolean) : unquote(value.trim());
  }
  return { data, body:content.slice(match[0].length) };
}

/** YAML folded style: single line breaks become spaces, a blank line is a paragraph break. */
function foldBlockScalar(lines:string[]):string {
  let out = "";
  for (const line of lines) {
    if (line === "") { if (out && !out.endsWith("\n")) out += "\n"; continue; }
    out += (out && !out.endsWith("\n") ? " " : "") + line;
  }
  return out.trim();
}

function unquote(value:string):string {
  return value.replace(/^["']|["']$/g, "");
}

/** The answer of a header edit: the new text, or the reason nothing was written. */
export type FrontmatterEdit = { content:string } | { refused:string };

/** A scalar as YAML: plain when that reads back as the same string, else a JSON (double-quoted) string. */
function yamlScalar(value:string, flow:boolean):string {
  const plain = value !== "" && value === value.trim() && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value) && !/: |:$| #/.test(value)
    && !(flow && /[,\[\]{}]/.test(value)) && !/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}
const yamlList = (values:string[]):string => `[${values.map((value) => yamlScalar(value, true)).join(", ")}]`;
const isChild = (line:string):boolean => /^[ \t]/.test(line) || /^-([ \t]|\r?$)/.test(line);
const isItem = (line:string):boolean => /^[ \t]*-([ \t]|\r?$)/.test(line);

/**
 * Edits only the header lines of the keys in `edits`; every other byte of the file stays. `change` gets the header
 * lines (a CRLF file keeps its "\r" on each line), the line break to write, and returns a reason to refuse.
 */
function editHeader(content:string, patch:Record<string, string | string[]>, change:(lines:string[], cr:string, key:string, value:string | string[]) => string | null): FrontmatterEdit {
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[A-Za-z_][\w-]*$/.test(key)) return { refused:`frontmatter: '${key}' is not a plain key name` };
    if ([value].flat().some((item) => /[\r\n]/.test(item))) return { refused:`frontmatter: the value of '${key}' has a line break; a header value is one line` };
  }
  const all = content.split("\n");
  const closing = /^---\r?$/.test(all[0] ?? "") ? all.findIndex((line, index) => index > 0 && /^---\r?$/.test(line)) : -1;
  if (closing < 0) {
    const cr = content.includes("\r\n") ? "\r" : "";
    const lines:string[] = [];
    for (const [key, value] of Object.entries(patch)) { const refused = change(lines, cr, key, value); if (refused) return { refused }; }
    return { content:`---${cr}\n${lines.join("\n")}${lines.length ? "\n" : ""}---${cr}\n${content}` };
  }
  const cr = all[0]!.endsWith("\r") ? "\r" : "";
  const head = all.slice(1, closing);
  for (const [key, value] of Object.entries(patch)) { const refused = change(head, cr, key, value); if (refused) return { refused }; }
  return { content:[all[0]!, ...head, ...all.slice(closing)].join("\n") };
}

/**
 * frontmatter: document header (SMA k_t_frontmatter): `set` puts the keys. Only the lines of the keys it sets change;
 * a new key goes before the closing `---`; the body and every other header line stay byte-identical. A key that is a
 * block scalar or has nested lines, a value with a line break are refused with the reason. A file with no header
 * gets one prepended.
 */
export function setFrontmatter(content:string, patch:Frontmatter): FrontmatterEdit {
  return editHeader(content, patch, (lines, cr, key, value) => {
    const line = `${key}: ${Array.isArray(value) ? yamlList(value) : yamlScalar(value, false)}${cr}`;
    const at = lines.findIndex((candidate) => candidate.startsWith(`${key}:`));
    if (at < 0) { lines.push(line); return null; }
    if (/^[|>]/.test(lines[at]!.slice(key.length + 1).trim()) || (at + 1 < lines.length && isChild(lines[at + 1]!))) return `frontmatter: '${key}' is a block scalar or has nested lines; it is not changed`;
    lines[at] = line;
    return null;
  });
}

/** `merge` adds list values without duplicates, in the key's own form (a flow list or `- item` lines). */
export function mergeFrontmatter(content:string, patch:Record<string, string | string[]>): FrontmatterEdit {
  return editHeader(content, patch, (lines, cr, key, value) => {
    const wanted = [value].flat();
    const at = lines.findIndex((candidate) => candidate.startsWith(`${key}:`));
    if (at < 0) { lines.push(`${key}: ${yamlList(wanted)}${cr}`); return null; }
    const rest = lines[at]!.slice(key.length + 1).trim();
    if (/^[|>]/.test(rest)) return `frontmatter: '${key}' is a block scalar; it is not changed`;
    const inline = /^\[(.*)\]$/.exec(rest);
    if (inline) {
      if (at + 1 < lines.length && isChild(lines[at + 1]!)) return `frontmatter: '${key}' has nested lines; it is not changed`;
      const have = inline[1]!.split(",").map((part) => part.trim()).filter(Boolean);
      const known = new Set(have.map(unquote));
      const add = wanted.filter((item, index) => !known.has(item) && wanted.indexOf(item) === index).map((item) => yamlScalar(item, true));
      if (add.length) lines[at] = `${key}: [${[...have, ...add].join(", ")}]${cr}`;
      return null;
    }
    if (rest !== "") return `frontmatter: '${key}' is a scalar, not a list; it is not changed`;
    let end = at + 1;
    while (end < lines.length && isItem(lines[end]!)) end++;
    if (end < lines.length && isChild(lines[end]!)) return `frontmatter: '${key}' has nested lines; it is not changed`;
    if (end === at + 1) { lines[at] = `${key}: ${yamlList(wanted)}${cr}`; return null; }
    const known = new Set(lines.slice(at + 1, end).map((line) => unquote(line.replace(/^[ \t]*-[ \t]*/, "").replace(/\r$/, "").trim())));
    const prefix = /^[ \t]*-[ \t]*/.exec(lines[at + 1]!)![0];
    const add = wanted.filter((item, index) => !known.has(item) && wanted.indexOf(item) === index).map((item) => `${prefix}${yamlScalar(item, false)}${cr}`);
    lines.splice(end, 0, ...add);
    return null;
  });
}
