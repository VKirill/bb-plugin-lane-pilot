// Region 11 · The forge — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The forge keeps its receipts in plugin KV (lp.forge.receipts), which has no timestamp to judge a trace by, and writes no hub table row:
// each node's trace is its own prove() line in the region scene scripts/lp_drill/scenes/sma_r11.py (docs/sma-evidence.md, «Trace choice»).
import { distort, drill, entry, flip, type RegionEvidence, voidIsHave } from "./types";

const LOGIC = "src/rooms/forge/logic.ts";
const TOOL = "src/rooms/forge/server/index.ts";

export default {
  n983: { mutation: distort(TOOL, 'risk: "low", lane: "default"', 'risk: "low", lane: "forge"'), reach: entry("the PM calls lane_pilot_forge draft (the Creator is a task of the ordinary writer pool)"), trace: drill("sma_r11") },
  n984: { mutation: distort(LOGIC, 'FORGE_KINDS = ["skill", "role", "workflow"] as const', 'FORGE_KINDS = ["skill", "role", "connection"] as const'), voidReview: voidIsHave("кузница держит типизированные черновики: skill, role (=agent), workflow; вид «connection» сознательно не делается — подключения добавляет человек в BB/Env Catalog (секреты)"), trace: drill("sma_r11") },
  n985: { mutation: distort(LOGIC, '"Never grant: permission bypass, every tool,', '"Never grant: nothing, every tool,'), trace: drill("sma_r11") },
  n986: { mutation: distort(TOOL, "owns_paths: [`${draftFolder(input.kind, input.name)}/`]", 'owns_paths: [".agents/forge/"]'), trace: drill("sma_r11") },
  n987: { mutation: distort(LOGIC, "`.agents/forge/${kind}s/${name}`", "`.agents/forge/${kind}/${name}`"), trace: drill("sma_r11") },
  n988: { mutation: flip(LOGIC, 'if (description.length < 40) found.push({ code: "description"', 'if (description.length > 40) found.push({ code: "description"'), trace: drill("sma_r11") },
  n989: { mutation: distort("src/rooms/forge/skill-lint.ts", "--dangerously-skip-permissions|bypassPermissions|permission-mode", "--dangerously-skip-permissions|permission-mode"), reach: entry("a forged draft is linted (lane_pilot_forge lint, or the Creator task's bb lane-pilot forge-lint check)"), trace: drill("sma_r11") },
  n990: { mutation: flip(TOOL, "if (!receipt.ok) throw refuse(", "if (receipt.ok) throw refuse("), trace: drill("sma_r11") },
  n991: { mutation: distort(TOOL, "path, sha256: sha256Hex(text), ok:", "path, sha256: sha256Hex(path), ok:"), trace: drill("sma_r11") },
  n992: { mutation: flip(TOOL, "if (!receipt.requestedAt) throw refuse(", "if (receipt.requestedAt) throw refuse("), reach: entry("the PM calls lane_pilot_forge enable (step request, then step confirm)"), trace: drill("sma_r11") },
} satisfies RegionEvidence;
