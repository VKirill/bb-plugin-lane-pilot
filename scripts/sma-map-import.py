#!/usr/bin/env python3
"""Writes src/rooms/sma-map/graph.ts from the SMA site map (scripts/sma-map/map-<sha>.json, the site's map-data.json without
coordinates) and scripts/sma-map/id-map.json (SMA id -> our node id). Every node keeps the region and group our registry and the
live queries name it by; a node the id map does not know gets the next free id. Run: python3 scripts/sma-map-import.py"""
import glob, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "scripts", "sma-map")
GRAPH = os.path.join(ROOT, "src", "rooms", "sma-map", "graph.ts")
KINDS = {"door": "window_door", "role": "model_role", "doc": "document"}

source_path = sorted(glob.glob(os.path.join(HERE, "map-*.json")))[-1]
data = json.load(open(source_path))
id_map_path = os.path.join(HERE, "id-map.json")
id_map = json.load(open(id_map_path))

# Region and group of each node as the current registry names them (SMA_NODES), so the live keys and entries stay valid.
current = open(GRAPH).read()
regions = json.loads(re.search(r"export const SMA_REGIONS = (\[.*?\]) as const;", current, re.S).group(1))
placed = {m.group(1): (int(m.group(2)), json.loads(m.group(3))) for m in re.finditer(r'\["(n\d+)", (\d+), ("(?:[^"\\]|\\.)*"), "', current)}

ours_by_block, ours_by_group = {}, {}
for node in data["nodes"]:
    local = id_map.get(node["id"])
    if local in placed:
        region, group = placed[local]
        ours_by_block.setdefault(node["block"], region)
        ours_by_group.setdefault((node["block"], node["group"]), group)

next_id = max(int(v[1:]) for v in id_map.values()) + 1
for node in data["nodes"]:
    if node["id"] not in id_map:
        id_map[node["id"]] = f"n{next_id}"
        next_id += 1
json.dump(id_map, open(id_map_path, "w"), ensure_ascii=False, indent=0)

def q(text):
    return json.dumps(text, ensure_ascii=False)

def region_of(node):
    if node["block"] in ours_by_block:
        return ours_by_block[node["block"]]
    sys.exit(f"no region for block {node['block']}")

nodes, sources = [], []
for node in data["nodes"]:
    local = id_map[node["id"]]
    region, group = placed.get(local, (region_of(node), ours_by_group.get((node["block"], node["group"]), node["group"])))
    kind = KINDS.get(node["kind"], node["kind"])
    nodes.append(f'  [{q(local)}, {region}, {q(group)}, {q(kind)}, {q(node["label"])}],')
    sources.append(f'  {local}: [{q(node["id"])}, {q(node["detail"])}, {q(node["source"])}, {"true" if node.get("unsure") else "false"}],')
links = [f'  [{q(id_map[e["from"]])}, {q(id_map[e["to"]])}, {q(e["kind"])}, {q(e.get("label") or "")}],' for e in data["edges"]]

out = f"""// Generated from the SMA site map (matveymaslov.com/map, code {data['sha']}: {os.path.relpath(source_path, ROOT)}) by
// scripts/sma-map-import.py: every node with its region, group, kind and label, the card's own words (what it does, where in SMA,
// whether SMA itself marks it unsure) and every link with its kind and label. Do not edit by hand.
export type SmaKind = "state" | "step" | "gate" | "check" | "window_door" | "screen" | "model_role" | "store" | "event" | "command" | "hook" | "document";
export type SmaLinkKind = "transition" | "calls" | "guards" | "writes" | "reads" | "shows" | "proves" | "retries";
export type SmaNode = readonly [id: string, region: number, group: string, kind: SmaKind, label: string];
/** The SMA card: its id on the site, what it does, its source in SMA, and SMA's own «unsure» mark (declared but not wired there). */
export type SmaCard = readonly [smaId: string, detail: string, source: string, unsure: boolean];
export const SMA_MAP_SHA = {q(data['sha'])};
export const SMA_REGIONS = {json.dumps(regions, ensure_ascii=False)} as const;
export const SMA_NODES: readonly SmaNode[] = [
{chr(10).join(nodes)}
];
export const SMA_CARDS: Readonly<Record<string, SmaCard>> = {{
{chr(10).join(sources)}
}};
export const SMA_LINKS: readonly (readonly [from: string, to: string, kind: SmaLinkKind, label: string])[] = [
{chr(10).join(links)}
];
"""
open(GRAPH, "w").write(out)
print(f"{len(nodes)} nodes, {len(links)} links -> {os.path.relpath(GRAPH, ROOT)}")
