// Region 10 · Telegram — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, entry, flip, type RegionEvidence, skipWrite } from "./types";

export default {
  // Nodes 960-982 (and n818 of region 9): tests in the sibling telegram plugin's PRIMARY checkout; the trace is the stand-in scene
  // sma_r10 (a fake Bot API and stand-in BB SDK, local recording transport); deployment of the plugin on the hub is unproved.
  n960: { mutation: flip("telegram:server.ts", "if (cfg.enabled && cfg.chatEnabled) {", "if (cfg.enabled) {"), trace: drill("sma_r10") },
  n961: { mutation: flip("telegram:server.ts", "if (!cfg.enabled || (cfg.chatEnabled && ownerId() && !bridge)) {", "if (cfg.enabled || (cfg.chatEnabled && ownerId() && !bridge)) {"), trace: drill("sma_r10") },
  n962: { mutation: distort("telegram:server.ts", "timeout: 25,", "timeout: 5,"), trace: drill("sma_r10") },
  n963: { mutation: distort("telegram:server.ts", "ingressBackoff = Math.min(ingressBackoff * 2, 300_000);", "ingressBackoff = Math.min(ingressBackoff + 10_000, 300_000);"), trace: drill("sma_r10") },
  n964: { mutation: flip("telegram:ingress.ts", "if (from.id !== owner) return cq", "if (from.id === owner) return cq"), trace: drill("sma_r10") },
  n965: { mutation: flip("telegram:ingress.ts", "return !cq && pairCode && code === pairCode", "return !cq && pairCode && code !== pairCode"), trace: drill("sma_r10") },
  n966: { mutation: skipWrite("telegram:server.ts", "bridge.accept(route.input);"), trace: drill("sma_r10") },
  n967: { mutation: flip("telegram:ingress.ts", "if (!callback && !text && !m.voice", "if (!callback && text && !m.voice"), trace: drill("sma_r10") },
  n968: { mutation: distort("telegram:chat.ts", "input: [{ type: \"text\", text, mentions: [] }],", "input: [{ type: \"text\", text: text.slice(1), mentions: [] }],"), trace: drill("sma_r10") },
  n969: { mutation: flip("telegram:server.ts", "(store.get<number>(\"chatOffSaidAt\") ?? 0) > 3_600_000", "(store.get<number>(\"chatOffSaidAt\") ?? 0) > -1"), trace: drill("sma_r10") },
  n970: { mutation: distort("telegram:chat.ts", "Date.now() - (b.typedAt ?? 0) > 4500", "Date.now() - (b.typedAt ?? 0) > 450000"), trace: drill("sma_r10") },
  // The worked example of a proof in the Telegram plugin (docs/sma-evidence.md «Proofs in a sibling repository»): the [sma:m_tg_split]
  // unit test lives in the sibling PRIMARY checkout; the trace is the stand-in scene sma_r10 on a local recording transport,
  // and whether the plugin is deployed on the hub is unproved.
  n971: { mutation: distort("telegram:chat.ts", 'let n = rest.length > limit ? rest.lastIndexOf("\\n", limit) : rest.length;', 'let n = rest.length > limit ? rest.lastIndexOf("\\n", limit / 2) : rest.length;'), trace: drill("sma_r10") },
  n972: { mutation: flip("telegram:chat.ts", "if (this.d.confirmNewChat?.()) {", "if (!this.d.confirmNewChat?.()) {"), trace: drill("sma_r10") },
  n973: { mutation: distort("telegram:adapters.ts", "signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),", "signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 1)]),"), trace: drill("sma_r10") },
  n974: { mutation: distort("telegram:adapters.ts", "throw new TelegramFailure(\"telegram_network\", 30, true);", "throw new TelegramFailure(\"telegram_network:\" + secret, 30, true);"), reach: entry("the plugin makes a call to the Bot API (a poll, a send, a check) and it fails"), trace: drill("sma_r10") },
  n975: { mutation: flip("telegram:server.ts", "tokenPresent: (await tokenSource()) !== \"none\",", "tokenPresent: (await tokenSource()) === \"none\","), trace: drill("sma_r10") },
  n976: { mutation: distort("telegram:server.ts", "const PAIR_TTL_MS = 10 * 60_000;", "const PAIR_TTL_MS = 5 * 60_000;"), trace: drill("sma_r10") },
  n977: { mutation: distort("telegram:server.ts", "https://t.me/${username}?start=${code}", "https://t.me/${username}?start=${code.toLowerCase()}"), trace: drill("sma_r10") },
  n978: { mutation: flip("telegram:server.ts", "ownerId() ? \"linked\" : \"awaiting_code\"", "ownerId() ? \"awaiting_code\" : \"linked\""), trace: drill("sma_r10") },
  n979: { mutation: skipWrite("telegram:server.ts", "settings.onChange(() => {\n    wake?.();", "settings.onChange(() => {\n    void wake;"), trace: drill("sma_r10") },
  n980: { mutation: skipWrite("telegram:server.ts", "store.put(\"pair:code\", code);"), trace: drill("sma_r10") },
  n981: { mutation: distort("telegram:server.ts", "store.put(\"owner:id\", route.userId);", "store.put(\"owner:id\", route.userId + 1);"), trace: drill("sma_r10") },
  n982: { mutation: skipWrite("telegram:server.ts", "store.del(\"owner:id\");"), trace: drill("sma_r10") },
} satisfies RegionEvidence;
