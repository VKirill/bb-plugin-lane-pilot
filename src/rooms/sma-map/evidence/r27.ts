// Region 27 · Shipping and honest numbers — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The ship verbs run in the release ritual (the owner at a terminal, `npm run gate` before a publish, the drill): they write no row to the hub
// database, so their trace is the region scene sma_r27, which runs the real verbs against fixture trees and the checked-out commit.
// n1738 (npm test: badge check) and n1748 (window distribution, bb-core) carry no evidence: see the batch report.
import { distort, drill, entry, flip, rows, type RegionEvidence } from "./types";

const SHIP = "scripts/lp-ship.ts";
const EXPLAIN = "src/rooms/tools/server/explain.ts";
const DRIVE = "scripts/lp-ui-drive.mjs";
const STAGE = "scripts/lib/ui-scene.mjs";
const SCENE = drill("sma_r27");

export default {
  n1733: { mutation: flip(SHIP, "if (!commands.has(m[1]!) && !/^(activate", "if (commands.has(m[1]!) && !/^(activate"), reach: entry("the owner runs lp-ship doc-audit, or the publish gate does"), trace: SCENE },
  n1734: { mutation: flip(SHIP, ".filter(([, row]) => !row.note);", ".filter(([, row]) => !!row.note);"), reach: entry("the owner runs lp-ship vendor before a release"), trace: SCENE },
  n1735: { mutation: flip(SHIP, 'const chosen = !code.length ? "docs" : full.length ? "full" : "batch";', 'const chosen = !code.length ? "docs" : full.length ? "batch" : "full";'), reach: entry("the owner asks lp-ship lane which lane a change ships through"), trace: SCENE },
  n1736: { mutation: flip(SHIP, "if (chosen.length < 2) {", "if (chosen.length <= 2) {"), reach: entry("the owner runs lp-ship batch on the backlog"), trace: SCENE },
  n1737: { mutation: flip(EXPLAIN, "docs.find((doc) => doc.topic === word) ??", "docs.find((doc) => doc.topic !== word) ??"), reach: entry("a person or the PM runs bb lane-pilot explain <word>"), trace: SCENE },
  n1738: { reach: entry("the owner runs npm test") },
  n1739: { mutation: flip(SHIP, "if (rc !== 0) { console.log(`gate: ${name} failed`); return rc; }", "if (rc === 0) { console.log(`gate: ${name} failed`); return rc; }"), reach: entry("the owner publishes the package: npm's prepublishOnly runs the gate"), trace: SCENE },
  n1740: { mutation: flip(DRIVE, "ok = text.includes(check.text);", "ok = !text.includes(check.text);"), reach: entry("the owner or an agent runs lp-ui-drive on a scene against a live window"), trace: SCENE },
  n1741: { mutation: distort(STAGE, 'src=\\"/app.js\\"', 'src=\\"/main.js\\"'), reach: entry("the owner or an agent stages a tree's built window with lp-ui-drive --stage"), trace: SCENE },
  n1742: { mutation: flip(SHIP, 'const color = /failed|fail/.test(text) ? "red" : "brightgreen";', 'const color = /failed|fail/.test(text) ? "brightgreen" : "red";'), reach: entry("the owner asks lp-ship badge for the number of the last test or drill run"), trace: SCENE },
  n1743: { mutation: flip(SHIP, "if (tag && !newer(pkg.version, tag))", "if (tag && newer(pkg.version, tag))"), reach: entry("the publish gate runs publishable --strict (npm prepublishOnly), or the owner asks lp-ship publishable"), trace: SCENE },
  n1744: { mutation: flip(SHIP, "promise.test(line) && !measured.test(line)", "promise.test(line) && measured.test(line)"), reach: entry("the publish gate or the deploy drill (lp-drill.sh --quick) runs predict-lint on the newest CHANGELOG entry"), trace: SCENE },
  n1745: { mutation: flip(SHIP, "} else if (undocumented.length > baseline) {", "} else if (undocumented.length < baseline) {"), reach: entry("the publish gate runs doc-audit --strict"), trace: SCENE },
  n1746: { mutation: distort(SHIP, "ledger[name] = { from, to: info.version };", "ledger[name] = { from: \"0.0.0\", to: info.version };"), reach: entry("the owner runs lp-ship vendor before a release"), trace: SCENE },
  n1747: { mutation: flip(SHIP, "&& !notices.includes(name)) findings.push", "&& notices.includes(name)) findings.push"), reach: entry("the publish gate runs the license scan, or the owner runs lp-ship licenses"), trace: SCENE },
  n1749: { mutation: flip(SHIP, "statSync(file).mtimeMs / 1000 > bundleTime", "statSync(file).mtimeMs / 1000 < bundleTime"), reach: entry("the publish gate runs freshness --strict right after the window build"), trace: SCENE },
  n1750: { mutation: flip("src/rooms/rollback/server/rollback.ts", 'state: ran.exitCode === 0 ? "green" : "red"', 'state: ran.exitCode !== 0 ? "green" : "red"'), reach: entry("a task lands: the merge is accepted and the landing sweep takes it"), trace: rows("lane_pilot_attempt_change", "updated_at", "suite_json IS NOT NULL") },
  n1751: { mutation: flip("src/rooms/self-repair/server/ship-watch.ts", "if (!watchIsOn(db, projectId)) continue;", "if (watchIsOn(db, projectId)) continue;"), trace: SCENE },
  n1752: { mutation: flip("src/rooms/backlog/logic.ts", 'if (record?.state !== "accepted" &&', 'if (record?.state === "accepted" &&'), trace: SCENE },
  n1753: { mutation: distort(EXPLAIN, ".map((doc) => doc.topic!)].sort();", ".map((doc) => doc.topic!)].sort().reverse();"), trace: SCENE },
  n1754: { mutation: flip(DRIVE, "return failed ? 1 : 0;", "return failed ? 0 : 1;"), trace: SCENE },
  n1755: { mutation: flip(STAGE, "n <= 0 || n > 65535", "n < 0 || n > 65535"), trace: SCENE },
} satisfies RegionEvidence;
