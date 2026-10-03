import { z } from "zod";

/**
 * One reading of a helper's JSON answer for every stage that parses one. The prompts ask for a bare object, but
 * models still add a sentence before it or wrap it in a fence; a stage must not fail for that. Tries, in order: the
 * whole text (an outer fence stripped), each fenced block from the last, then the outermost braces (or brackets).
 * The caller's schema still validates keys, enums and caps.
 */
export function extractModelJson(raw: string, shape: "object" | "array" = "object"): unknown {
  const text = raw.trim();
  const open = shape === "object" ? "{" : "[";
  const close = shape === "object" ? "}" : "]";
  const fits = (value: unknown) => shape === "array" ? Array.isArray(value) : Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const candidates: string[] = [text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const block of [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi)].reverse()) candidates.push(block[1]!);
  const parse = (candidate: string): unknown => {
    try {
      const value = JSON.parse(candidate.trim());
      return fits(value) ? value : undefined;
    } catch { return undefined; }
  };
  for (const candidate of candidates) {
    const value = parse(candidate);
    if (value !== undefined) return value;
  }
  // Prose around the JSON may hold braces of its own (`function a() { … }`): try each opening, longest slice first.
  const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length && starts.length < 100; i += 1) if (text[i] === open) starts.push(i);
  for (let i = text.length - 1; i >= 0 && ends.length < 10; i -= 1) if (text[i] === close) ends.push(i);
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) break;
      const value = parse(text.slice(start, end + 1));
      if (value !== undefined) return value;
    }
  }
  throw new Error(`model_output_not_json_${shape}`);
}

/** A text field whose overlong value is cut to its ceiling instead of failing the whole answer. */
export const clipped = (max: number, min = 1) => z.preprocess(
  (value) => typeof value === "string" && value.length > max ? value.slice(0, max) : value,
  z.string().min(min).max(max),
);

/** For reviewers that get everything in the prompt: the reason for the ban, since the thread itself is not read-only. */
export const NO_TOOLS_LINE = "Everything you need is in this message, so open no files, run no commands and call no tools: this thread has full access to the project checkout, and anything you create or change there would be counted as part of the task's changes.";
