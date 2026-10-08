// One-off: cut src/rooms/contracts/index.ts into schemas.ts, host.ts and six rpc-*.ts parts (verbatim text), and make
// index.ts assemble them. tmp/contract-snapshot.ts compares the JSON schema of all 184 methods before and after.
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./graph";

const dir = join(ROOT, "src/rooms/contracts");
const source = readFileSync(join(dir, "index.ts"), "utf8");
const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true);

/** Method name -> part. A part runs from its first method to the one before the next part's first method. */
const PARTS: { file: string; first: string; doc: string }[] = [
  { file: "rpc-shell", first: "get_preferences", doc: "Preferences, projects and sections, global settings and agent profiles." },
  { file: "rpc-native", first: "finish_run", doc: "Activating the PM, the native session, helper threads." },
  { file: "rpc-runs", first: "get_run_card", doc: "Run cards, stages, helper access and the screen snapshot." },
  { file: "rpc-settings", first: "save_setting", doc: "Saving settings and the model selections of every role." },
  { file: "rpc-ops", first: "halt_run", doc: "Run control, statistics, deploy, self-repair, canary and the stack installer." },
  { file: "rpc-knowledge", first: "list_councils", doc: "Councils, rules, memory, docs, token usage, secrets and the workspace provider." },
  { file: "rpc-workflow", first: "workflow_list", doc: "Workflows: library, runs, drafts, the editor and the architect." },
];

const imports = sf.statements.filter(ts.isImportDeclaration);
const importedNames = new Map<string, string>(); // local name -> import statement text
for (const imp of imports) {
  const clause = imp.importClause;
  if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const e of clause.namedBindings.elements) importedNames.set(e.name.text, imp.moduleSpecifier.getText());
}

const decl = (name: string) => sf.statements.find((s): s is ts.VariableStatement => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText() === name))!;
const hostStatement = decl("hostContract");
const rpcStatement = decl("rpcContract");
const rpcObject = (rpcStatement.declarationList.declarations[0]!.initializer as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression;

// top-level declarations other than the imports and the two contracts
const topLevel = sf.statements.filter((s) => !ts.isImportDeclaration(s) && s !== hostStatement && s !== rpcStatement);
const declaredNames = new Map<string, ts.Statement>();
const exportedNames = { values: [] as string[], types: [] as string[] };
for (const s of topLevel) {
  const isExported = (ts.getCombinedModifierFlags(s as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { declaredNames.set(d.name.getText(), s); if (isExported) exportedNames.values.push(d.name.getText()); }
  else if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) { declaredNames.set(s.name.text, s); if (isExported) exportedNames.types.push(s.name.text); }
  else if (ts.isFunctionDeclaration(s) && s.name) { declaredNames.set(s.name.text, s); if (isExported) exportedNames.values.push(s.name.text); }
}

const words = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

// property chunks of the rpc contract
const props = rpcObject.properties;
const nameOf = (p: ts.ObjectLiteralElementLike) => (ts.isSpreadAssignment(p) ? p.expression.getText() : p.name!.getText());
const starts = PARTS.map((part) => props.findIndex((p) => nameOf(p) === part.first));
if (starts.some((i) => i < 0)) throw new Error("a part boundary is not a method: " + JSON.stringify(PARTS.map((p, i) => [p.first, starts[i]])));
const chunkText = (from: number, to: number) => {
  const first = props[from]!;
  const last = props[to - 1]!;
  // include the leading comments of the first property but not the previous property's trailing comma
  const begin = first.getFullStart();
  return source.slice(begin, last.getEnd()).replace(/^[\s,]*\n/, "\n");
};
// the first part also owns the spread that leads the object
const bounds = starts.map((start, i) => [i === 0 ? 0 : start, i + 1 < starts.length ? starts[i + 1]! : props.length] as const);

const needed = new Set<string>(); // schema names the host and rpc files use
const hostText = hostStatement.getText();
const chunks = PARTS.map((part, i) => ({ part, text: chunkText(bounds[i]![0], bounds[i]![1]) }));
for (const text of [hostText, ...chunks.map((c) => c.text)]) for (const w of words(text)) if (declaredNames.has(w)) needed.add(w);

// ---- schemas.ts: every top-level declaration that is not a contract, the ones the parts use exported ----
let schemas = "";
const schemaStatements = topLevel.map((s) => {
  let text = source.slice(s.getFullStart(), s.getEnd());
  const names = ts.isVariableStatement(s) ? s.declarationList.declarations.map((d) => d.name.getText()) : [((s as ts.TypeAliasDeclaration).name?.text) ?? ""];
  const isExported = (ts.getCombinedModifierFlags(s as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  if (!isExported && names.some((n) => needed.has(n))) text = source.slice(s.getFullStart(), s.getStart()) + "export " + source.slice(s.getStart(), s.getEnd());
  return text;
});
schemas = schemaStatements.join("");
const fix = (mod: string) => mod; // specifiers are copied as written; every new file sits next to index.ts

function importBlock(text: string, schemaNames: Set<string>): string {
  const used = words(text);
  const byModule = new Map<string, string[]>();
  for (const [name, mod] of importedNames) if (used.has(name)) byModule.set(fix(mod), [...(byModule.get(fix(mod)) ?? []), name]);
  const lines = [...byModule].map(([mod, names]) => `import { ${names.join(", ")} } from ${mod};`);
  const fromSchemas = [...schemaNames].filter((n) => used.has(n)).sort();
  if (fromSchemas.length) lines.push(`import { ${fromSchemas.join(", ")} } from "./schemas";`);
  return lines.join("\n");
}

const schemaFile = `${importBlock(schemas, new Set())}\n${schemas.replace(/^\n+/, "\n")}`;
writeFileSync(join(dir, "schemas.ts"), schemaFile.replace(/\n{3,}/g, "\n\n"));

const neededSchema = new Set([...needed]);
writeFileSync(join(dir, "host.ts"), `${importBlock(hostText, neededSchema)}\n\n${hostText}\n`);
for (const { part, text } of chunks) {
  const body = `/** ${part.doc} */\nexport const ${part.file.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())} = {${text.replace(/,?\s*$/, "")},\n};\n`;
  writeFileSync(join(dir, `${part.file}.ts`), `${importBlock(body, neededSchema)}\n\n${body}`);
}

const partNames = PARTS.map((p) => p.file.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()));
const indexText = `import { defineRpcContract } from "@get-bb/plugin-sdk";
${PARTS.map((p, i) => `import { ${partNames[i]} } from "./${p.file}";`).join("\n")}

// The RPC contracts of the plugin. The schemas are in schemas.ts, the host methods in host.ts and the methods of the
// screens in the rpc-*.ts parts; this file assembles them and is the only public file of the room.
export { ${exportedNames.values.sort().join(", ")} } from "./schemas";
export type { ${exportedNames.types.sort().join(", ")} } from "./schemas";
export { hostContract } from "./host";

export const rpcContract = defineRpcContract({
${partNames.map((n) => `  ...${n},`).join("\n")}
});
`;
writeFileSync(join(dir, "index.ts"), indexText);
console.log("written", ["schemas", "host", ...PARTS.map((p) => p.file), "index"].join(", "));
