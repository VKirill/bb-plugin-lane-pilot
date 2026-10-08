import { applyEdits, findNodeAtLocation, modify, parseTree, type Node } from "jsonc-parser/lib/esm/main.js";

const OLD = "./plugins/lane-context.ts";
const NEW = "./plugins/opencode-lane.ts";

export type JsoncPatchResult =
  | { ok:true; changed:boolean; text:string }
  | { ok:false; code:"invalid_jsonc"|"invalid_root"|"duplicate_plugin"|"duplicate_owned_plugin"|"nested_plugin"|"invalid_plugin"; message:string };

function propertyName(node: Node): string | null {
  return node.type === "property" && node.children?.[0]?.type === "string"
    ? String(node.children[0].value)
    : null;
}

function hasNestedPlugin(node: Node, depth = 0): boolean {
  if (depth > 1 && propertyName(node) === "plugin") return true;
  return node.children?.some((child) => hasNestedPlugin(child, depth + 1)) ?? false;
}

export function patchOpenCodePlugin(text: string): JsoncPatchResult {
  const errors: Array<{error:number; offset:number; length:number}> = [];
  let root = parseTree(text, errors, { allowTrailingComma:true, disallowComments:false });
  if (!root || errors.length > 0) return { ok:false, code:"invalid_jsonc", message:"input is not valid JSONC" };
  if (root.type !== "object") return { ok:false, code:"invalid_root", message:"top-level value must be an object" };
  const topProperties = (root.children ?? []).filter((node) => propertyName(node) === "plugin");
  if (topProperties.length > 1) return { ok:false, code:"duplicate_plugin", message:"top-level plugin key must be unique" };
  if (topProperties.length === 0 && hasNestedPlugin(root)) {
    return { ok:false, code:"nested_plugin", message:"nested plugin key is not a supported top-level plugin list" };
  }
  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (!pluginNode) {
    const next = applyEdits(text, modify(text, ["plugin"], [NEW], {
      formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
    }));
    return { ok:true, changed:next !== text, text:next };
  }
  if (pluginNode.type !== "array" || (pluginNode.children ?? []).some((child) => child.type !== "string")) {
    return { ok:false, code:"invalid_plugin", message:"top-level plugin must be an array of strings" };
  }
  const originalValues = (pluginNode.children ?? []).map((child) => String(child.value));
  const wanted = originalValues.filter((value) => value !== OLD);
  if (!wanted.includes(NEW)) wanted.push(NEW);
  if (wanted.length === originalValues.length && wanted.every((value, index) => value === originalValues[index])) {
    return { ok:true, changed:false, text };
  }
  let next = text;
  const firstOld = originalValues.indexOf(OLD);
  if (firstOld >= 0 && !originalValues.includes(NEW)) {
    const oldNode = pluginNode.children?.[firstOld];
    if (!oldNode) return { ok:false, code:"invalid_plugin", message:"plugin element cannot be located" };
    next = `${next.slice(0, oldNode.offset)}${JSON.stringify(NEW)}${next.slice(oldNode.offset + oldNode.length)}`;
  }
  root = parseTree(next, [], { allowTrailingComma:true, disallowComments:false });
  const currentNode = root ? findNodeAtLocation(root, ["plugin"]) : undefined;
  const currentValues = (currentNode?.children ?? []).map((child) => String(child.value));
  for (let index = currentValues.length - 1; index >= 0; index -= 1) {
    const keepReplacedFirst = !originalValues.includes(NEW) && index === firstOld;
    if (currentValues[index] === OLD && !keepReplacedFirst) {
      next = applyEdits(next, modify(next, ["plugin", index], undefined, {
        formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
      }));
    }
  }
  root = parseTree(next, [], { allowTrailingComma:true, disallowComments:false });
  const afterNode = root ? findNodeAtLocation(root, ["plugin"]) : undefined;
  const afterValues = (afterNode?.children ?? []).map((child) => String(child.value));
  if (!afterValues.includes(NEW)) {
    next = applyEdits(next, modify(next, ["plugin", -1], NEW, {
      isArrayInsertion:true,
      formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
    }));
  }
  return { ok:true, changed:next !== text, text:next };
}

export function ensureOpenCodePluginEntry(text: string, entry = NEW): JsoncPatchResult {
  const errors: Array<{error:number; offset:number; length:number}> = [];
  let root = parseTree(text, errors, { allowTrailingComma:true, disallowComments:false });
  if (!root || errors.length > 0) return { ok:false, code:"invalid_jsonc", message:"input is not valid JSONC" };
  if (root.type !== "object") return { ok:false, code:"invalid_root", message:"top-level value must be an object" };
  const topProperties = (root.children ?? []).filter((node) => propertyName(node) === "plugin");
  if (topProperties.length > 1) return { ok:false, code:"duplicate_plugin", message:"top-level plugin key must be unique" };
  if (topProperties.length === 0 && hasNestedPlugin(root)) {
    return { ok:false, code:"nested_plugin", message:"nested plugin key is not a supported top-level plugin list" };
  }
  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (!pluginNode) {
    const next = applyEdits(text, modify(text, ["plugin"], [entry], {
      formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
    }));
    return { ok:true, changed:next !== text, text:next };
  }
  if (pluginNode.type !== "array" || (pluginNode.children ?? []).some((child) => child.type !== "string")) {
    return { ok:false, code:"invalid_plugin", message:"top-level plugin must be an array of strings" };
  }
  if ((pluginNode.children ?? []).some((child) => String(child.value) === entry)) {
    return { ok:true, changed:false, text };
  }
  const next = applyEdits(text, modify(text, ["plugin", -1], entry, {
    isArrayInsertion:true,
    formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
  }));
  return { ok:true, changed:next !== text, text:next };
}

export function removeOpenCodePluginEntry(text: string, entry = NEW): JsoncPatchResult {
  const errors: Array<{error:number; offset:number; length:number}> = [];
  const root = parseTree(text, errors, { allowTrailingComma:true, disallowComments:false });
  if (!root || errors.length > 0) return { ok:false, code:"invalid_jsonc", message:"input is not valid JSONC" };
  if (root.type !== "object") return { ok:false, code:"invalid_root", message:"top-level value must be an object" };
  const topProperties = (root.children ?? []).filter((node) => propertyName(node) === "plugin");
  if (topProperties.length > 1) return { ok:false, code:"duplicate_plugin", message:"top-level plugin key must be unique" };
  if (topProperties.length === 0 && hasNestedPlugin(root)) {
    return { ok:false, code:"nested_plugin", message:"nested plugin key is not a supported top-level plugin list" };
  }
  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (!pluginNode) return { ok:true, changed:false, text };
  if (pluginNode.type !== "array" || (pluginNode.children ?? []).some((child) => child.type !== "string")) {
    return { ok:false, code:"invalid_plugin", message:"top-level plugin must be an array of strings" };
  }
  const indexes = (pluginNode.children ?? [])
    .map((child, index) => String(child.value) === entry ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) {
    return { ok:false, code:"duplicate_owned_plugin", message:"multiple matching plugin entries make ownership ambiguous; no entry was removed" };
  }
  if (indexes.length === 0) return { ok:true, changed:false, text };
  const next = applyEdits(text, modify(text, ["plugin", indexes[0]], undefined, {
    formattingOptions: { insertSpaces:true, tabSize:2, eol:"\n" },
  }));
  return { ok:true, changed:next !== text, text:next };
}
