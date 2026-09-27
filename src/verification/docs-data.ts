/**
 * The data map for a workspace that defines a Prisma schema: each model with its fields, enums and
 * relations, and - across the whole repository - where the code writes and reads it and which literal
 * values it writes into status-like fields. The docs agent explains meaning and lifecycle from it
 * instead of copying the schema.
 */

export type PrismaField = { name:string; type:string; line:number; note:string };
export type PrismaModel = { name:string; table:string | null; file:string; line:number; endLine:number; fields:PrismaField[] };
export type PrismaEnum = { name:string; values:string[]; file:string; line:number };

/** Models and enums of one .prisma file, with each field's type and trailing comment. */
export function parsePrisma(file:string, text:string):{ models:PrismaModel[]; enums:PrismaEnum[] } {
  const lines = text.split("\n");
  const models:PrismaModel[] = [], enums:PrismaEnum[] = [];
  for (let index = 0; index < lines.length; index++) {
    const start = /^(model|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(lines[index]!);
    if (!start) continue;
    let end = index + 1;
    while (end < lines.length && !/^\}/.test(lines[end]!)) end++;
    const body = lines.slice(index + 1, end);
    if (start[1] === "enum") {
      enums.push({ name:start[2]!, file, line:index + 1, values:body.map((line) => line.trim().split(/\s|\/\//)[0]!).filter((value) => /^[A-Za-z_]\w*$/.test(value)) });
    } else {
      const fields = body.flatMap((line, offset) => {
        const field = /^\s+([A-Za-z_]\w*)\s+([A-Za-z_][\w]*(?:\[\])?\??)(.*)$/.exec(line);
        if (!field || field[1]!.startsWith("@@")) return [];
        // A field's note is its trailing comment, or the comment lines right above it.
        let above = "";
        for (let at = offset - 1; at >= 0 && /^\s*\/\//.test(body[at]!); at--) above = `${body[at]!.replace(/^\s*\/\/\s*/, "")} ${above}`;
        return [{ name:field[1]!, type:field[2]!, line:index + 2 + offset, note:[above.trim(), (/\/\/\s*(.*)$/.exec(field[3]!)?.[1] ?? "").trim()].filter(Boolean).join(" ") }];
      });
      const table = /@@map\(\s*["']([^"']+)["']/.exec(body.join("\n"))?.[1] ?? null;
      models.push({ name:start[2]!, table, file, line:index + 1, endLine:end + 1, fields });
    }
    index = end;
  }
  return { models, enums };
}

const WRITE_OPS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];
const READ_OPS = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"];
const STATUS_FIELDS = /\b(status|state|phase|stage|mode|kind|type)\s*:\s*['"]([\w.:-]+)['"]/g;

export type ModelAccess = { writes:Array<{ file:string; line:number; op:string; values:string[] }>; reads:Array<{ file:string; line:number; op:string }> };

const SQL_WRITE = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi;
const SQL_STATUS = /\b(status|state|phase|stage|mode|kind|type)\s*=\s*'([\w.:-]+)'/gi;

/** snake_case column name to the camelCase field name Prisma uses. */
const camel = (name:string) => name.toLowerCase().replace(/_([a-z0-9])/g, (_, char:string) => char.toUpperCase());

/**
 * Every Prisma delegate call on these models in the given files, and raw SQL that writes their tables; a write keeps the
 * status-like literals in its arguments. `tables` maps a table name to its model.
 */
export function prismaAccess(files:Map<string, string>, models:string[], tables:Map<string, string> = new Map()):Map<string, ModelAccess> {
  const delegates = new Map(models.map((model) => [model.charAt(0).toLowerCase() + model.slice(1), model]));
  const access = new Map<string, ModelAccess>(models.map((model) => [model, { writes:[], reads:[] }]));
  const call = new RegExp(`\\b(?:prisma|tx|trx|db|client|this\\.prisma|this\\.db|ctx\\.prisma)\\s*\\.\\s*(${[...delegates.keys()].join("|") || "$^"})\\s*\\.\\s*(${[...WRITE_OPS, ...READ_OPS].join("|")})\\s*\\(`, "g");
  for (const [file, text] of files) {
    for (const match of text.matchAll(call)) {
      const model = delegates.get(match[1]!)!;
      const line = text.slice(0, match.index).split("\n").length;
      if (WRITE_OPS.includes(match[2]!)) {
        const args = text.slice(match.index!, match.index! + 600);
        access.get(model)!.writes.push({ file, line, op:match[2]!, values:[...new Set([...args.matchAll(STATUS_FIELDS)].map((value) => `${value[1]}=${value[2]}`))] });
      } else access.get(model)!.reads.push({ file, line, op:match[2]! });
    }
    // Raw SQL writes: lease, refund and bulk transitions often bypass the Prisma client.
    for (const match of text.matchAll(SQL_WRITE)) {
      const model = tables.get(match[2]!.toLowerCase());
      if (!model) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const statement = text.slice(match.index!, match.index! + 600);
      access.get(model)!.writes.push({ file, line, op:`SQL ${match[1]!.split(/\s+/)[0]!.toUpperCase()}`,
        values:[...new Set([...statement.matchAll(SQL_STATUS)].map((value) => `${camel(value[1]!)}=${value[2]}`))] });
    }
  }
  return access;
}

/** The brief section: per model its table, fields (enum values and written literals inline), writers and readers. */
export function renderDataMap(models:PrismaModel[], enums:PrismaEnum[], access:Map<string, ModelAccess>):string[] {
  if (!models.length) return [];
  const enumValues = new Map(enums.map((item) => [item.name, item]));
  const modelNames = new Set(models.map((model) => model.name));
  const lines = ["", "## Data map", "",
    "Every Prisma model with its fields, enums and references, and where the whole repository writes and reads it; `values written` are",
    "literals the code passes to status-like fields at write sites - the raw material for each table's lifecycle. Explain meaning, allowed values,",
    "lifecycle and invariants from the code; do not copy this list into the docs.", ""];
  for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    const used = access.get(model.name) ?? { writes:[], reads:[] };
    lines.push(`### ${model.name}${model.table ? ` -> ${model.table}` : ""} (${model.file}:${model.line}-${model.endLine})`);
    for (const field of model.fields) {
      const base = field.type.replace(/[[\]?]/g, "");
      const enumInfo = enumValues.get(base);
      const written = [...new Set(used.writes.flatMap((write) => write.values).filter((value) => value.startsWith(`${field.name}=`)).map((value) => value.slice(field.name.length + 1)))];
      const extra = [enumInfo ? `enum ${enumInfo.name}: ${enumInfo.values.join(", ")}` : "", modelNames.has(base) ? `-> ${base}` : "",
        written.length ? `values written: ${written.slice(0, 12).join(", ")}` : "", field.note ? `// ${field.note}` : ""].filter(Boolean).join("; ");
      lines.push(`- ${field.name} ${field.type} (line ${field.line})${extra ? ` - ${extra}` : ""}`);
    }
    const writers = [...new Set(used.writes.map((write) => `${write.file}:${write.line} ${write.op}`))];
    const readers = [...new Set(used.reads.map((read) => read.file))];
    lines.push(`- writes (${used.writes.length}): ${writers.slice(0, 15).join(", ") || "none found"}${writers.length > 15 ? ", …" : ""}`);
    lines.push(`- read in (${readers.length} files): ${readers.slice(0, 10).join(", ") || "none found"}${readers.length > 10 ? ", …" : ""}`, "");
  }
  return lines;
}
