import { secretShaped } from "../tasks";

/**
 * The daemon's front outside the graphs (SMA map: First run, Bring your own helpers, Machines and one household, Entry and pass). Pure:
 * the server half (server/index.ts) reads and writes through BB, the host and the settings.
 */

/** Four question steps of the first-run interview: what the project is, who writes, how strict, how the owner takes part. */
export const FIRST_RUN_STEPS = [
  { id: "goal", question: "What is this project and what should Lane Pilot do in it first?", setting: null },
  { id: "writer", question: "Which provider and model should write the code (for example codex / gpt-6-luna)?", setting: "writer" },
  { id: "quality", question: "How strict should the checks be: quick, standard or full?", setting: "quality_mode" },
  { id: "words", question: "Should Lane Pilot wait for your word before every task lands (yes), only before risky work lands (risky, the default) or decide by its gates in code (no)?", setting: "owner.words" },
] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]["id"];
export type FirstRunDraft = { projectId: string; answers: Partial<Record<FirstRunStep, string>>; at: number; done?: number };

/** Is a first run needed: the project has no writer chosen and the interview was never finished. */
export const firstRunNeeded = (settings: Readonly<Record<string, unknown>>, draft: FirstRunDraft | null) =>
  !draft?.done && !settings["writer.provider"] && !settings["writerProviderId"];

/** An answer into the draft; a secret-shaped one never reaches it (No secret reaches the draft). */
export function answerFirstRun(draft: FirstRunDraft, step: FirstRunStep, answer: string, now = Date.now()): FirstRunDraft {
  if (secretShaped(answer)) throw new Error("this answer looks like a key or a password: it is not kept; save secrets in Env Catalog and answer with their name");
  return { ...draft, answers: { ...draft.answers, [step]: answer.trim().slice(0, 2000) }, at: now };
}

/** The settings the finished interview writes — through the one profile writer, nothing else. */
export function firstRunSettings(draft: FirstRunDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const writer = draft.answers.writer?.split("/").map((part) => part.trim()).filter(Boolean) ?? [];
  if (writer.length === 2) { out["writer.provider"] = writer[0]; out["writer.model"] = writer[1]; }
  const quality = draft.answers.quality?.trim().toLowerCase();
  if (quality && ["quick", "standard", "full"].includes(quality)) out.quality_mode = quality;
  const words = draft.answers.words?.trim().toLowerCase();
  if (words) out["owner.words"] = /risk|риск|high|высок/.test(words) ? "risky" : /^(yes|да|on)/.test(words) ? "on" : "off";
  return out;
}

/** Format parsers of the project's own helpers: Claude Code and OpenCode agents (front matter), Codex agents (TOML name/description). */
export type ForeignHelper = { source: string; name: string; description: string; body: string; format: "claude" | "opencode" | "codex"; kind: "agent" | "skill" };
/** The directories another tool keeps its definitions in: agents, and skills as <root>/<name>/SKILL.md (SMA m_im_scan). */
export const HELPER_ROOTS = [".claude/agents", ".opencode/agent", ".opencode/agents", ".codex/agents", ".claude/skills", ".opencode/skill", ".opencode/skills", ".codex/skills"] as const;
export function parseHelper(path: string, text: string): ForeignHelper | null {
  const skill = /\/(?:skills?)\/[^/]+\/SKILL\.md$/.test(path);
  const format = path.startsWith(".claude/") ? "claude" : path.startsWith(".opencode/") ? "opencode" : path.startsWith(".codex/") ? "codex" : null;
  if (!format || !(HELPER_ROOTS as readonly string[]).some((root) => path.startsWith(`${root}/`))) return null;
  const kind = skill ? "skill" : "agent";
  if (format === "codex" && !skill) {
    const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? path.split("/").pop()!.replace(/\.toml$/, "");
    const description = text.match(/^description\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    const body = text.match(/^(?:instructions|prompt)\s*=\s*"""([\s\S]*?)"""/m)?.[1] ?? "";
    return { source: path, name, description, body, format, kind };
  }
  if (!text.startsWith("---\n")) return null;
  const head = text.slice(4).split("\n---", 1)[0] ?? "";
  const field = (key: string) => head.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"))?.[1] ?? "";
  // A skill is named by its folder (SKILL.md), an agent by its file name.
  const fallback = skill ? path.split("/").at(-2)! : path.split("/").pop()!.replace(/\.md$/, "");
  const name = field("name") || fallback;
  return { source: path, name, description: field("description"), body: text.slice(4 + head.length + 4).trim(), format, kind };
}

/** A helper as a forge draft (the name kept; the forge lint decides whether it may be enabled): a role draft for an agent, a SKILL.md for a skill. */
export function helperDraft(helper: ForeignHelper): string {
  const name = helper.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 47);
  const role = helper.kind === "skill" ? "" : "model: sonnet\ntools: Read, Grep, Glob, Bash\n";
  return `---\nname: ${name}\ndescription: "${(helper.description || `Imported ${helper.format} ${helper.kind}`).replace(/"/g, "'")}"\n${role}---\n\n${helper.body}\n\n<!-- imported from ${helper.source} (${helper.format}) -->\n`;
}

/** One action — one line: the RPC calls that change something, by name. */
export const MUTATING_RPC = /^(save|set|reset|apply|cancel|close|phase_act|phase_control|task_word|answer|word|conveyor|configure|defer|deferral_defer|deferral_close|retry|revert|install|enable|disable|delete|archive|start|stop|pause|resume|mark|approve|reject|accept|first_run|coord_clear|helpers_import|backlog_issue)/;

/** Machines: presence only — what a peer's last snapshot says when it does not answer now. Memory-only, age-labelled, lost on restart (SMA m_mc_snapshot). */
export type PeerSnapshot = { hostId: string; name: string | null; online: boolean; at: number; lastOnlineAt: number | null;
  /** The peer's ordinary board (its subscription windows) as it last answered; answered false when the call failed (SMA m_mc_poll). */
  windows?: unknown; answered?: boolean;
  /** What the machine works on and did today: the projects of its runs and the attempts changed in the last day (SMA m_sw_machines). */
  today?: { projects: string[]; accepted: number; blocked: number; running: number } };
/** The board summary a peer answered with: each subscription window as `name %`, or «нет окон» when the machine answered with none (SMA m_mc_poll). */
function windowsSummary(answer: unknown): string {
  const windows = (answer as { windows?: unknown } | null)?.windows;
  const entries = windows && typeof windows === "object" ? Object.entries(windows as Record<string, { utilization?: unknown }>) : [];
  if (!entries.length) return "нет окон";
  return entries.map(([name, window]) => `${name} ${typeof window?.utilization === "number" ? `${window.utilization}%` : "?"}`).join(", ");
}

export function peerLine(peer: PeerSnapshot, now = Date.now()): string {
  const base = peer.online
    ? `${peer.name ?? peer.hostId}: на связи`
    : `${peer.name ?? peer.hostId}: не отвечает (last seen ${peer.lastOnlineAt ? `${Math.round((now - peer.lastOnlineAt) / 60_000)} min` : "never"} ago)`;
  // An online peer's board: silent (the call failed), answered with windows, or answered with none — the line tells them apart.
  const board = !peer.online ? "" : peer.answered === false ? " · доска не ответила" : peer.answered ? ` · окна: ${windowsSummary(peer.windows)}` : "";
  if (!peer.today) return base + board;
  const today = peer.today;
  return `${base}${board} · проекты: ${today.projects.join(", ") || "—"} · сегодня: принято ${today.accepted}, стоит ${today.blocked}, идёт ${today.running}`;
}
