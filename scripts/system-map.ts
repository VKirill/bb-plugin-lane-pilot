/**
 * The system map of Lane Pilot: one interactive HTML page (docs/map/index.html) where every node and link is read from the code.
 * Nodes: areas → rooms (components) with their tables, CLI commands, agent tools and graph actions; workspace packages; shipped
 * graphs; roles; task stages and attempt states. Links: imports between rooms and packages, a room reading another room's table,
 * a graph running a graph, calling an action, giving a step to a role; stage order and attempt transitions.
 * Written by `npx tsx scripts/generate-atlas.ts` next to the atlas.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { STAGE_PROOF } from "@lane-pilot/contracts";
import { TRANSITION_TABLE } from "../src/rooms/contracts/state-machine";

type Node = { id: string; label: string; type: string; parent?: string; file?: string; info?: string; x?: number; y?: number };
type Edge = { source: string; target: string; type: string };
export type SystemMap = { nodes: Node[]; edges: Edge[] };

/** Rooms by the part of the system they serve; a room not listed lands in «Other». */
const AREAS: Record<string, string[]> = {
  "Task pipeline": ["writer", "runs", "tasks", "acceptance", "baseline", "verification", "validators", "critique", "qa", "stage-return", "pilot", "phase", "run-goal", "rollback", "backlog", "receipts", "conveyor", "work-graph"],
  "Graphs and schedule": ["workflow", "night-graphs", "schedule", "relay", "forge"],
  "PM, agents and doors": ["native-agent", "native-install", "session-hooks", "guard-tools", "permits", "secrets", "tools", "front", "cockpit", "council", "outbound", "host-worker", "project-life"],
  "Models, Jev, money": ["jev", "capability", "usage", "money"],
  "Memory and the owner": ["memory", "memory-eval", "memory-probe", "memory-tiers", "anamnesis", "learning", "rule-forms", "docs"],
  "Self-improvement": ["wall", "night", "bench", "harness", "hypotheses", "improvement", "self-improve", "self-repair", "lead", "errands", "policy", "checkers", "coverage", "twins", "forecast", "design-eval", "pm-replay", "sma-map", "atlas", "wires"],
  "Stability and the owner's list": ["stability", "outage", "deferral", "owner-waiting", "owner-presence"],
  "Platform": ["core", "storage", "contracts", "settings", "ui-shell"],
  "Pixel World": ["world", "world-assets"],
};

export function collectSystemMap(root: string): SystemMap {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "tests" || name === "dist") return [];
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const roomsDir = join(root, "src/rooms");
  const rooms = readdirSync(roomsDir).filter((name) => statSync(join(roomsDir, name)).isDirectory()).sort();
  const packages = readdirSync(join(root, "packages")).filter((name) => statSync(join(root, "packages", name)).isDirectory()).sort();
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const add = (node: Node) => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
  const link = (source: string, target: string, type: string) => { if (source !== target) edges.set(`${source}>${target}>${type}`, { source, target, type }); };

  const areaOf = new Map(Object.entries(AREAS).flatMap(([area, list]) => list.map((room) => [room, area] as const)));
  for (const area of [...Object.keys(AREAS), "Other"]) add({ id: `area:${area}`, label: area, type: "area" });
  add({ id: "area:Packages", label: "Workspace packages", type: "area" });
  add({ id: "area:Graphs", label: "Shipped graphs", type: "area" });
  add({ id: "area:Roles", label: "Roles", type: "area" });
  add({ id: "group:stages", label: "Task stages", type: "group", parent: "area:Task pipeline" });
  add({ id: "group:states", label: "Attempt states", type: "group", parent: "area:Task pipeline" });
  add({ id: "group:lp-graphs", label: "Own maintenance graphs (lp.*)", type: "group", parent: "area:Graphs" });
  add({ id: "group:work-graphs", label: "Work graphs", type: "group", parent: "area:Graphs" });
  for (const room of rooms) add({ id: `room:${room}`, label: room, type: "room", parent: `area:${areaOf.get(room) ?? "Other"}`, file: `src/rooms/${room}/` });
  for (const pkg of packages) add({ id: `pkg:${pkg}`, label: `@lane-pilot/${pkg}`, type: "package", parent: "area:Packages", file: `packages/${pkg}/` });

  const ownerOf = (path: string): string | null => {
    const rel = relative(root, path).split("/");
    if (rel[0] === "src" && rel[1] === "rooms" && rel[2] && rooms.includes(rel[2])) return `room:${rel[2]}`;
    if (rel[0] === "packages" && rel[1] && packages.includes(rel[1])) return `pkg:${rel[1]}`;
    return null;
  };
  const files = [...walk(roomsDir), ...walk(join(root, "packages"))];
  const source = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));

  // Imports: a room or package that imports another one.
  for (const [path, text] of source) {
    const from = ownerOf(path);
    if (!from) continue;
    for (const hit of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = hit[1]!;
      const target = spec.startsWith("@lane-pilot/") ? `pkg:${spec.split("/")[1]}` : spec.startsWith(".") ? ownerOf(resolve(dirname(path), spec)) : null;
      if (target && nodes.has(target)) link(from, target, "imports");
    }
  }

  // Tables: the room whose migration creates it owns it; another room naming it reads it.
  // Rooms that describe the whole system (maps, registries) name every table and own none of them.
  const describers = new Set(["room:sma-map", "room:wires", "room:atlas", "room:coverage"]);
  const rank = (path: string) => /migrations?\.ts$/.test(path) ? 0 : /(database|store|journal|schema)\.ts$/.test(path) ? 1 : 2;
  const declared = new Map<string, { owner: string; rank: number }>();
  for (const [path, text] of source) for (const hit of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(lane_pilot_[a-z0-9_]+)/g)) {
    const owner = ownerOf(path);
    if (!owner || describers.has(owner)) continue;
    const seen = declared.get(hit[1]!);
    if (!seen || rank(path) < seen.rank) declared.set(hit[1]!, { owner, rank: rank(path) });
  }
  const tables = new Map([...declared].map(([table, { owner }]) => [table, owner]));
  for (const [table, owner] of tables) add({ id: `table:${table}`, label: table, type: "table", parent: owner });
  // ponytail: substring scan, tables × files; fine at ~120 tables and ~1500 files (a second or two).
  for (const [path, text] of source) {
    const from = ownerOf(path);
    if (!from || describers.has(from)) continue;
    for (const [table, owner] of tables) if (owner !== from && new RegExp(`\\b${table}\\b`).test(text)) link(from, `table:${table}`, "reads");
  }

  // Agent tools, by the room that registers them.
  for (const [path, text] of source) for (const hit of text.matchAll(/name:\s*"(lane_pilot_[a-z_]+)"/g)) {
    const owner = ownerOf(path);
    if (owner) add({ id: `tool:${hit[1]}`, label: hit[1]!, type: "tool", parent: owner, file: relative(root, path) });
  }

  // Graph actions, by the room or package that registers them.
  for (const [path, text] of source) for (const hit of text.matchAll(/(?:engine\.register(?:<[^>]*>)?|(?:^|[^.\w])action)\(\s*"([a-z0-9_.:-]+)"/gm)) {
    const owner = ownerOf(path);
    if (owner) add({ id: `action:${hit[1]}`, label: hit[1]!, type: "action", parent: owner, file: relative(root, path) });
  }

  // CLI commands, by the room whose handler the dispatch calls.
  const cliPath = join(root, "src/rooms/tools/server/cli.ts");
  const cli = readFileSync(cliPath, "utf8");
  const symbolRoom = new Map<string, string>();
  for (const hit of cli.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const owner = ownerOf(resolve(dirname(cliPath), hit[2]!));
    if (owner) for (const name of hit[1]!.split(",")) symbolRoom.set(name.trim().split(/\s+as\s+/).pop()!, owner);
  }
  const dispatch = [...cli.matchAll(/command === "([a-z0-9-]+)"/g)];
  const handledBy = new Map<string, string>();
  dispatch.forEach((hit, index) => {
    const body = cli.slice(hit.index!, dispatch[index + 1]?.index ?? cli.length);
    const owner = [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((call) => symbolRoom.get(call[1]!)).find(Boolean);
    if (owner && !handledBy.has(hit[1]!)) handledBy.set(hit[1]!, owner);
  });
  // A handler reached through the services object names no import: the command's first word, when it is a room, is its home.
  const prefixRoom = (command: string) => {
    const word = command.split("-")[0]!;
    return rooms.includes(command) ? `room:${command}` : rooms.includes(word) ? `room:${word}` : "room:tools";
  };
  for (const hit of cli.matchAll(/\{ name:"([a-z0-9-]+)", summary:"((?:[^"\\]|\\.)*)"/g)) {
    add({ id: `cmd:${hit[1]}`, label: `bb lane-pilot ${hit[1]}`, type: "command", parent: handledBy.get(hit[1]!) ?? prefixRoom(hit[1]!), info: hit[2]!.replace(/\\"/g, '"') });
  }

  // Stages in order and the attempt state machine.
  const stageIds = Object.keys(STAGE_PROOF);
  stageIds.forEach((id, index) => {
    const proof = STAGE_PROOF[id as keyof typeof STAGE_PROOF] as { kind: string; check?: string; reason?: string };
    add({ id: `stage:${id}`, label: id, type: "stage", parent: "group:stages", info: `${proof.kind}: ${proof.check ?? proof.reason ?? ""}` });
    if (index) link(`stage:${stageIds[index - 1]}`, `stage:${id}`, "next");
  });
  for (const row of TRANSITION_TABLE) {
    const from = row.from ?? "(new)";
    const to = row.to === "stay" ? from : row.to;
    for (const state of [from, to]) add({ id: `state:${state}`, label: state, type: "state", parent: "group:states" });
    link(`state:${from}`, `state:${to}`, "transition");
  }

  // Shipped graphs: what each runs, calls and hands to a role.
  const graphs = readdirSync(join(root, "workflows")).filter((file) => file.endsWith(".json")).sort()
    .map((name) => ({ name, graph: JSON.parse(readFileSync(join(root, "workflows", name), "utf8")) as Record<string, unknown> & { id: string } }));
  const en = (value: unknown) => typeof value === "string" ? value : (value as { en?: string } | undefined)?.en ?? "";
  for (const { name, graph } of graphs) add({ id: `graph:${graph.id}`, label: graph.id, type: "graph", parent: graph.id.startsWith("lp.") ? "group:lp-graphs" : "group:work-graphs",
    file: `workflows/${name}`, info: `${en(graph.name)}. ${en(graph.description)}`.slice(0, 400) });
  const visit = (graphId: string, value: unknown): void => {
    if (Array.isArray(value)) { value.forEach((item) => visit(graphId, item)); return; }
    if (!value || typeof value !== "object") return;
    const step = value as Record<string, unknown>;
    if (step.type === "subworkflow" && typeof step.workflow === "string") link(`graph:${graphId}`, `graph:${step.workflow}`, "runs");
    if (step.type === "action" && typeof step.action === "string" && nodes.has(`action:${step.action}`)) link(`graph:${graphId}`, `action:${step.action}`, "calls");
    if (step.type === "agent" && typeof step.role === "string") {
      add({ id: `role:${step.role}`, label: step.role, type: "role", parent: "area:Roles" });
      link(`graph:${graphId}`, `role:${step.role}`, "assigns");
    }
    Object.values(step).forEach((child) => visit(graphId, child));
  };
  for (const { graph } of graphs) visit(graph.id, graph);

  const kept = [...edges.values()].filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
  const parents = new Set([...nodes.values()].map((node) => node.parent).filter(Boolean));
  const list = [...nodes.values()].filter((node) => !["area", "group"].includes(node.type) || parents.has(node.id));
  place(list);
  return { nodes: list, edges: kept };
}

/**
 * A tidy, deterministic layout: boxes inside boxes, packed in shelves (areas → rooms → their tables, commands, tools, actions).
 * Links do not move anything, so the map reads like a floor plan and stays the same between runs. Leaves get x/y (their centre);
 * the renderer sizes every box around its children.
 */
function place(list: Node[]): void {
  const kids = new Map<string, Node[]>();
  for (const node of list) if (node.parent) kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]);
  const PAD: Record<string, [number, number]> = { area: [30, 56], group: [14, 34], room: [10, 26], package: [10, 26] }; // [side, top]
  const GAP: Record<string, number> = { area: 70, group: 24, room: 18 };
  type Box = { w: number; h: number; at: Array<{ node: Node; dx: number; dy: number; box: Box }> };
  const measure = (node: Node): Box => {
    const children = kids.get(node.id) ?? [];
    if (!children.length) return { w: Math.max(40, node.label.length * 5.6 + 14), h: 22, at: [] };
    const boxes = children.map((child) => ({ node: child, box: measure(child) }))
      .sort((a, b) => b.box.h - a.box.h || b.box.w - a.box.w || a.node.label.localeCompare(b.node.label));
    const gap = GAP[node.type] ?? 8;
    const area = boxes.reduce((sum, item) => sum + (item.box.w + gap) * (item.box.h + gap), 0);
    const widest = Math.max(...boxes.map((item) => item.box.w));
    const limit = Math.max(widest, Math.sqrt(area) * (node.type === "canvas" ? 1.5 : node.type === "area" ? 1.9 : 1.4));
    const [side, top] = PAD[node.type] ?? [10, 26];
    let x = 0, y = 0, row = 0, width = 0;
    const at: Box["at"] = [];
    for (const item of boxes) {
      if (x > 0 && x + item.box.w > limit) { x = 0; y += row + gap; row = 0; }
      at.push({ node: item.node, dx: side + x, dy: top + y, box: item.box });
      x += item.box.w + gap; row = Math.max(row, item.box.h); width = Math.max(width, x - gap);
    }
    return { w: width + side * 2, h: top + y + row + side, at };
  };
  const put = (box: Box, left: number, top: number) => {
    for (const item of box.at) {
      if (item.box.at.length) put(item.box, left + item.dx, top + item.dy);
      else { item.node.x = Math.round(left + item.dx + item.box.w / 2); item.node.y = Math.round(top + item.dy + item.box.h / 2); }
    }
  };
  // The top level (areas) packed into shelves of one wide canvas.
  kids.set("(canvas)", list.filter((node) => !node.parent));
  GAP.canvas = 90;
  PAD.canvas = [0, 0];
  put(measure({ id: "(canvas)", label: "", type: "canvas" }), 0, 0);
}

const COLORS: Record<string, string> = {
  room: "#e8f0fe", package: "#ede7f6", table: "#fff3cd", command: "#d1e7dd", tool: "#cfe2ff", action: "#f8d7da",
  graph: "#e2e3e5", role: "#ffe5d0", stage: "#d2f4ea", state: "#f5e1ff",
};
const EDGE_COLORS: Record<string, string> = {
  imports: "#9aa5b1", reads: "#d39e00", runs: "#6c757d", calls: "#dc3545", assigns: "#fd7e14", next: "#198754", transition: "#8e44ad",
};

export function renderSystemMap(map: SystemMap, stamp: string): string {
  const tally = (list: Array<{ type: string }>) => Object.entries(list.reduce<Record<string, number>>((all, item) => ({ ...all, [item.type]: (all[item.type] ?? 0) + 1 }), {}));
  const leaf = map.nodes.filter((node) => !["area", "group"].includes(node.type));
  const data = JSON.stringify({ nodes: map.nodes, edges: map.edges, colors: COLORS, edgeColors: EDGE_COLORS }).replace(/</g, "\\u003c");
  const legend = tally(leaf).map(([type, n]) => `<label><input type="checkbox" data-node="${type}" checked><i style="background:${COLORS[type] ?? "#fff"}"></i>${type} ${n}</label>`).join("");
  const edgeLegend = tally(map.edges).map(([type, n]) => `<label><input type="checkbox" data-edge="${type}" ${["reads", "imports", "assigns"].includes(type) ? "" : "checked"}><i style="background:${EDGE_COLORS[type] ?? "#999"};height:3px"></i>${type} ${n}</label>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lane Pilot — the system map</title>
<style>
*{box-sizing:border-box}body{margin:0;font:13px/1.4 -apple-system,system-ui,sans-serif;color:#1f2328;background:#f6f8fa;height:100vh;display:flex;flex-direction:column}
header{background:#0d1117;color:#e6edf3;padding:10px 16px}header h1{font-size:16px;margin:0}header p{margin:2px 0 0;color:#9198a1;font-size:12px}
#bar{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:8px 16px;background:#fff;border-bottom:1px solid #d0d7de}
#bar label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}#bar i{display:inline-block;width:12px;height:12px;border:1px solid #8c959f;border-radius:2px}
#bar input[type=search]{padding:4px 8px;border:1px solid #d0d7de;border-radius:6px;min-width:220px}#bar b{color:#59636e;font-weight:600}
main{flex:1;display:flex;min-height:0}#cy{flex:1}#side{width:340px;overflow:auto;background:#fff;border-left:1px solid #d0d7de;padding:12px 14px}
#side h2{font-size:14px;margin:0 0 4px;word-break:break-all}#side .t{color:#59636e;font-size:12px}#side ul{padding-left:16px;margin:4px 0 10px}#side li{cursor:pointer;color:#0969da}
#status{color:#59636e}
</style></head><body>
<header><h1>Lane Pilot — the system map</h1><p>${leaf.length} nodes · ${map.edges.length} links · every node and link is read from the code (${stamp}) · scroll to zoom, drag to move, click a node to see every link it has</p></header>
<div id="bar"><input type="search" id="q" placeholder="Find a room, table, command, graph…"><b>Nodes</b>${legend}<b>Links</b>${edgeLegend}<span id="status">loading…</span></div>
<main><div id="cy"></div><aside id="side"><p class="t">Areas hold rooms (the components in <code>src/rooms/</code>); a room holds its tables, commands, agent tools and graph actions. Click anything; the panel lists what it contains, what it points to and what points to it.</p></aside></main>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script>
const D=${data};
const cy=cytoscape({container:document.getElementById("cy"),layout:{name:"preset",fit:true,padding:30},wheelSensitivity:0.3,minZoom:0.03,maxZoom:4,
 elements:[...D.nodes.map(n=>({data:n,...(n.x!=null?{position:{x:n.x,y:n.y}}:{})})),...D.edges.map((e,i)=>({data:{id:"e"+i,...e}}))],
 style:[
  {selector:"node",style:{label:"data(label)","font-size":9,"text-valign":"center","text-halign":"center",width:n=>n.isParent()?undefined:Math.max(40,n.data("label").length*5.6+14),height:16,padding:4,shape:"round-rectangle","background-color":n=>D.colors[n.data("type")]||"#fff","border-width":1,"border-color":"#8c959f"}},
  {selector:":parent",style:{"text-valign":"top","text-halign":"center","font-size":12,"font-weight":600,"background-opacity":0.5,"background-color":"#ddf4ff","border-color":"#54aeff",padding:6}},
  {selector:'node[type="area"]',style:{"font-size":64,"font-weight":700,color:"#57606a","background-color":"#f0f6fc","border-color":"#8c959f","border-style":"dashed",padding:24}},
  {selector:'node[type="group"]',style:{"font-size":16,"background-color":"#f6f8fa"}},
  {selector:"edge",style:{width:0.8,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.5,"line-color":e=>D.edgeColors[e.data("type")]||"#999","target-arrow-color":e=>D.edgeColors[e.data("type")]||"#999",opacity:0.5}},
  {selector:".off",style:{display:"none"}},
  {selector:".dim",style:{opacity:0.07}},
  {selector:".hit",style:{"border-width":3,"border-color":"#cf222e"}},
 ]});
const hiddenEdges=new Set([...document.querySelectorAll("[data-edge]")].filter(b=>!b.checked).map(b=>b.dataset.edge));
const hiddenNodes=new Set();
function apply(){cy.batch(()=>{cy.nodes().forEach(n=>n.toggleClass("off",hiddenNodes.has(n.data("type"))));cy.edges().forEach(e=>e.toggleClass("off",hiddenEdges.has(e.data("type"))||e.source().hasClass("off")||e.target().hasClass("off")))})}
document.querySelectorAll("[data-node]").forEach(b=>b.onchange=()=>{b.checked?hiddenNodes.delete(b.dataset.node):hiddenNodes.add(b.dataset.node);apply()});
document.querySelectorAll("[data-edge]").forEach(b=>b.onchange=()=>{b.checked?hiddenEdges.delete(b.dataset.edge):hiddenEdges.add(b.dataset.edge);apply()});
apply();
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const item=o=>"<li data-id=\\""+esc(o.id())+"\\">"+esc(o.data("label"))+" <span class=t>"+esc(o.data("type"))+"</span></li>";
function show(n){
 cy.elements().removeClass("dim hit");apply();
 n.union(n.descendants()).connectedEdges().removeClass("off");
 const inside=n.descendants();
 const near=n.closedNeighborhood().union(inside).union(inside.neighborhood()).union(n.ancestors());
 cy.elements().not(near.union(near.ancestors())).addClass("dim");n.addClass("hit");
 const group=(list,dir)=>{const by={};list.forEach(e=>{const o=dir==="out"?e.target():e.source();(by[e.data("type")]=by[e.data("type")]||[]).push(o)});return Object.entries(by).map(([t,os])=>"<div class=t>"+(dir==="out"?"→ ":"← ")+esc(t)+" ("+os.length+")</div><ul>"+os.map(item).join("")+"</ul>").join("")};
 const kids=n.children();
 document.getElementById("side").innerHTML="<h2>"+esc(n.data("label"))+"</h2><div class=t>"+esc(n.data("type"))+(n.data("file")?" · <code>"+esc(n.data("file"))+"</code>":"")+"</div>"+(n.data("info")?"<p>"+esc(n.data("info"))+"</p>":"")
  +(kids.length?"<div class=t>contains ("+kids.length+")</div><ul>"+kids.map(item).join("")+"</ul>":"")
  +group(n.outgoers("edge"),"out")+group(n.incomers("edge"),"in");
 document.querySelectorAll("#side li").forEach(li=>li.onclick=()=>{const o=cy.getElementById(li.dataset.id);show(o);cy.animate({center:{eles:o},zoom:Math.max(cy.zoom(),1)},{duration:300})});
}
cy.on("tap","node",ev=>show(ev.target));
cy.on("tap",ev=>{if(ev.target===cy){cy.elements().removeClass("dim hit");apply()}});
document.getElementById("q").oninput=ev=>{const q=ev.target.value.trim().toLowerCase();cy.elements().removeClass("dim hit");if(!q)return;const hits=cy.nodes().filter(n=>n.data("label").toLowerCase().includes(q));cy.elements().not(hits.union(hits.ancestors())).addClass("dim");hits.addClass("hit");if(hits.length)cy.animate({fit:{eles:hits,padding:80}},{duration:300})};
document.getElementById("status").textContent="";window.__mapReady=true;
</script></body></html>
`;
}
