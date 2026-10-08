import type { DraftOp } from "../../src/rooms/workflow/draft";

/**
 * The patches the architect makes for «search the web in the browser, analyse documents, write a summary, send it to
 * Telegram after my approval», in the order a conversation would produce them: first the frame, then each step as the
 * owner confirms it, then the test case.
 */
export const META_OPS: DraftOp[] = [
  { op: "set_meta", set: {
    inputs: [
      { name: "query", type: "string" },
      { name: "documents", type: "string", required: false, note: "folder or file list the analysis reads" },
      { name: "chat", type: "string", default: "me" },
    ],
    outputs: [
      { name: "status", type: "enum", values: ["sent", "aborted"] },
      { name: "message_id", type: "string", required: false },
      { name: "summary_md", type: "string", required: false },
    ],
    requires: { skills: ["telegram-user", "telegram-rich-messages"], plugins: ["browser-automation"], browserSession: true },
    triggers: [{ type: "chat" }, { type: "manual" }],
  } },
];

export const SEARCH_OPS: DraftOp[] = [
  { op: "add_node", node: {
    id: "search", type: "agent", role: "researcher", title: { en: "Search the web", ru: "Найти в интернете" },
    prompt: "Open the owner's browser (browser-automation), search for `query`, read the top pages. Read only: change nothing. A login wall or captcha is `blocked`.",
    skills: ["browser-automation"],
    out: [{ name: "sources", type: "array" }, { name: "count", type: "number" }, { name: "status", type: "enum", values: ["done", "blocked"] }],
    timeoutSec: 900,
  } },
  { op: "add_edge", edge: { from: "start", to: "search", with: { query: "input.query" } } },
];

export const ANALYZE_OPS: DraftOp[] = [
  { op: "add_node", node: {
    id: "analyze", type: "agent", role: "analyst", title: { en: "Analyse the documents", ru: "Разобрать документы" },
    prompt: "Read the documents in `documents` together with the pages found. List the findings, each with its source.",
    out: [{ name: "findings", type: "array" }, { name: "notes", type: "string" }],
  } },
  { op: "add_edge", edge: { from: "search", to: "analyze", when: "search.status == 'done'", with: { sources: "search.sources", documents: "input.documents" } } },
];

export const SUMMARY_OPS: DraftOp[] = [
  { op: "add_node", node: {
    id: "summarize", type: "agent", role: "analyst", title: { en: "Write the summary", ru: "Написать сводку" },
    prompt: "Write a short digest of the findings for Telegram: headline, five bullets, links.",
    skills: ["telegram-rich-messages"],
    out: [{ name: "summary_md", type: "string" }],
  } },
  { op: "add_edge", edge: { from: "analyze", to: "summarize", with: { findings: "analyze.findings" } } },
  { op: "add_node", node: {
    id: "approve", type: "human", question: "Send this digest to Telegram?", options: ["send", "abort"],
    out: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["send", "abort", "timeout"] }],
    timeoutSec: 7200,
  } },
  { op: "add_edge", edge: { from: "summarize", to: "approve" } },
];

export const SEND_OPS: DraftOp[] = [
  { op: "add_node", node: {
    id: "send", type: "action", action: "telegram.send_rich", params: { target: "{{$inputs.chat}}", markdown: "{{summarize.summary_md}}" },
    out: [{ name: "message_id", type: "string" }], maxAttempts: 1,
  } },
  { op: "add_edge", edge: { from: "approve", to: "send", when: "approve.answer_kind == 'send'" } },
  { op: "add_node", node: { id: "sent", type: "action", action: "emit", map: { status: "sent", message_id: "send.message_id", summary_md: "summarize.summary_md" } } },
  { op: "add_edge", edge: { from: "send", to: "sent" } },
  { op: "add_node", node: { id: "aborted", type: "action", action: "emit", map: { status: "aborted" } } },
  { op: "add_edge", edge: { from: "approve", to: "aborted" } },
  { op: "add_edge", edge: { from: "search", to: "aborted", when: "search.status == 'blocked'" } },
];

export const TEST_OPS: DraftOp[] = [
  { op: "set_meta", set: { test: { id: "digest", sim: {
    input: { query: "design systems", documents: "docs/", chat: "me" },
    stubs: { search: { status: "done", count: 3, sources: ["https://a.example", "https://b.example", "https://c.example"] } },
    human_answers: { approve: "send" },
    expect_path: ["search", "analyze", "summarize", "approve", "send", "sent"],
    expect_output: { status: "sent", message_id: "stub send.message_id" },
    variant_blocked: { stubs: { search: { status: "blocked" } }, expect_path: ["search", "aborted"], expect_output: { status: "aborted" } },
    variant_declined: { human_answers: { approve: "abort" }, expect_path: ["search", "analyze", "summarize", "approve", "aborted"], expect_output: { status: "aborted" } },
  } } } },
];

export const BROWSER_DIGEST_STEPS: DraftOp[][] = [META_OPS, SEARCH_OPS, ANALYZE_OPS, SUMMARY_OPS, SEND_OPS, TEST_OPS];
