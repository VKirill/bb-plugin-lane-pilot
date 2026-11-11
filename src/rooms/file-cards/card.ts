/**
 * SMA k_lib_catalog: a file's card is a pure function of its bytes and its git facts — no model, no
 * clock. Same inputs, same card.
 */
import { createHash } from "node:crypto";

export type GitFacts = { lastCommit: string | null; commits: number };

export type FileCard = {
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  language: string;
  /** First doc comment or first non-empty line, clipped. */
  headLine: string;
  exports: string[];
  lastCommit: string | null;
  commits: number;
};

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", rs: "rust", go: "go", json: "json", md: "markdown", sh: "shell", bash: "shell",
  css: "css", html: "html", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
};

const DOC_HEAD = /^\s*(?:\/\*\*?|\*|<!--|#|"""|''')/;

function headLineOf(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A leading doc comment's first real words win over a bare opener line.
    if (DOC_HEAD.test(trimmed)) {
      const inner = trimmed.replace(/^(?:\/\*+|\*+\/?|<!--|#+|"""|''')\s?/, "").replace(/(?:\*\/|-->)\s*$/, "").trim();
      if (inner) return inner.slice(0, 200);
      continue;
    }
    return trimmed.slice(0, 200);
  }
  return "";
}

function exportsOf(text: string, language: string): string[] {
  const names = new Set<string>();
  if (language === "python") {
    for (const match of text.matchAll(/^(?:def|class)\s+([A-Za-z_]\w*)/gm)) names.add(match[1]!);
  } else {
    for (const match of text.matchAll(/^\s*export\s+(?:async\s+)?(?:default\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]!);
    for (const match of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
      for (const part of match[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
    for (const match of text.matchAll(/^\s*export\s+default\b/gm)) names.add("default");
  }
  return [...names].sort();
}

/** One card from a file's bytes and its git facts; deterministic in `bytes` and `git` alone. */
export function buildFileCard(input: { path: string; bytes: Uint8Array | string; git?: GitFacts }): FileCard {
  const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
  const text = bytes.toString("utf8");
  const extension = input.path.split(".").pop()?.toLowerCase() ?? "";
  const language = LANGUAGES[extension] ?? "text";
  return {
    path: input.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    lines: text ? text.split("\n").length : 0,
    language,
    headLine: headLineOf(text),
    exports: exportsOf(text, language),
    lastCommit: input.git?.lastCommit ?? null,
    commits: input.git?.commits ?? 0,
  };
}
