export interface RoomGraphSummary {
  rooms: number;
  largestScc: number;
  mutualPairs: number;
  edges: number;
}

export interface RoomGraph {
  summary: RoomGraphSummary;
  /** Members of the largest strongly connected component (sorted). */
  scc: string[];
  /** Room pairs importing each other (sorted pairs). */
  mutual: string[][];
  rooms: string[];
  edges: Map<string, Set<string>>;
  fanIn: Map<string, number>;
}

export function roomGraph(root: string): RoomGraph;
