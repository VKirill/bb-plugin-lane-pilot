/**
 * SMA k_lib_catalog: a file's card is a pure function of its bytes and its git facts — no model, no
 * clock. Same inputs, same card.
 */
import { createHash } from "node:crypto";
// The session hook runs this file as plain source (node --experimental-strip-types): a relative import needs its .ts suffix.
// @ts-expect-error TS5097
import { maskCredentials } from "../../../packages/kit/src/redact.ts";
// @ts-expect-error TS5097
import { secretPathHit } from "../../../packages/kit/src/secret-files.ts";

/** A file over this is never read for a card; the first PEEK_BYTES are looked at for a NUL byte (binary). */
export const CARD_MAX_BYTES = 256 * 1024;
export const CARD_PEEK_BYTES = 8 * 1024;

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
  /** Set when no text was read: a secret-looking name, a binary or an over-size file. The card then holds name and size only. */
  skipped?: "secret" | "binary" | "large";
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

const mask = (text: string) => maskCredentials(text).text;

/**
 * One card from a file's bytes and its git facts; deterministic in the inputs alone. `size` is the file's real size when
 * `bytes` is only its first bytes (an over-size file is never read whole). A secret-looking path, a binary (NUL in the
 * first 8 KB) and a file over 256 KB get a card of name and size only; every text field of the others passes the
 * credential mask, so a token on a file's first line never reaches a card.
 */
export function buildFileCard(input: { path: string; bytes: Uint8Array | string; git?: GitFacts; size?: number }): FileCard {
  const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
  const extension = input.path.split(".").pop()?.toLowerCase() ?? "";
  const language = LANGUAGES[extension] ?? "text";
  const size = input.size ?? bytes.length;
  const skipped = secretPathHit(input.path) ? "secret" : size > CARD_MAX_BYTES ? "large" : bytes.subarray(0, CARD_PEEK_BYTES).includes(0) ? "binary" : undefined;
  if (skipped) {
    return { path: input.path, sha256: "", bytes: size, lines: 0, language, headLine: "", exports: [], lastCommit: input.git?.lastCommit ?? null, commits: input.git?.commits ?? 0, skipped };
  }
  const text = bytes.toString("utf8");
  return {
    path: input.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    lines: text ? text.split("\n").length : 0,
    language,
    headLine: mask(headLineOf(text)),
    exports: exportsOf(text, language).map(mask),
    lastCommit: input.git?.lastCommit ?? null,
    commits: input.git?.commits ?? 0,
  };
}
