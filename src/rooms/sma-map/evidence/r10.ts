// Region 10 · Telegram — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, type RegionEvidence } from "./types";

export default {
  // The worked example of a proof in the Telegram plugin (docs/sma-evidence.md «Proofs in a sibling repository»): the [sma:m_tg_split]
  // test is in bb-plugin-telegram-projects on sma/proofs; reach and trace stay open while the plugin is disabled on the hub.
  n971: { mutation: distort("telegram:chat.ts", 'let n = rest.length > limit ? rest.lastIndexOf("\\n", limit) : rest.length;', 'let n = rest.length > limit ? rest.lastIndexOf("\\n", limit / 2) : rest.length;') },
} satisfies RegionEvidence;
