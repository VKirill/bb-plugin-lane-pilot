import { useLayoutEffect, useRef, useState } from "react";

export type TaskGraphNode = { id: string; title: string; state: "running" | "waiting" | "queued" | "blocked"; threadId: string | null };
export type TaskGraphEdge = { from: string; to: string; kind: "depends" | "files" | "folder" | "question" };
export type TaskGraphData = { nodes: TaskGraphNode[]; edges: TaskGraphEdge[] };

const EDGE_LOOK: Record<TaskGraphEdge["kind"], { color: string; dash?: string; label: string }> = {
  depends: { color: "var(--color-primary, #8b5cf6)", label: "после неё (depends_on)" },
  files: { color: "#d97706", dash: "4 3", label: "те же файлы" },
  folder: { color: "#64748b", dash: "2 3", label: "одна папка без git" },
  question: { color: "#dc2626", dash: "6 3", label: "ждёт ответа на вопрос" },
};
const STATE_LABEL: Record<TaskGraphNode["state"], string> = { running: "работает", waiting: "ждёт", queued: "в очереди", blocked: "заблокирована" };

/**
 * The step of each task: 0 for one that waits for no shown task, else one more than the latest step it waits for. Tasks on
 * one step run side by side; a wait that loops (never expected) stops climbing after as many steps as there are tasks.
 */
export function taskSteps(graph: TaskGraphData): Map<string, number> {
  const step = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (let round = 0; round < graph.nodes.length; round++) {
    let moved = false;
    for (const edge of graph.edges) {
      const from = step.get(edge.from), to = step.get(edge.to);
      if (from === undefined || to === undefined || to > from) continue;
      step.set(edge.to, from + 1);
      moved = true;
    }
    if (!moved) break;
  }
  return step;
}

type Line = { key: string; d: string; kind: TaskGraphEdge["kind"] };

/** The open run's tasks by step, top to bottom, with an arrow from each task to the ones that wait for it. */
export function TaskGraphView({ graph, onOpen }: { graph: TaskGraphData; onOpen?: (node: TaskGraphNode) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const chips = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<Line[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const steps = taskSteps(graph);
  const rows: TaskGraphNode[][] = [];
  for (const node of graph.nodes) (rows[steps.get(node.id) ?? 0] ??= []).push(node);
  const kinds = [...new Set(graph.edges.map((edge) => edge.kind))];
  const shape = JSON.stringify([graph.nodes.map((node) => node.id), graph.edges]);

  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const draw = () => {
      const origin = root.getBoundingClientRect();
      const next: Line[] = [];
      for (const edge of graph.edges) {
        const from = chips.current.get(edge.from)?.getBoundingClientRect();
        const to = chips.current.get(edge.to)?.getBoundingClientRect();
        if (!from || !to) continue;
        const x1 = from.left + from.width / 2 - origin.left, y1 = from.bottom - origin.top;
        const x2 = to.left + to.width / 2 - origin.left, y2 = to.top - origin.top;
        const bend = Math.max(12, (y2 - y1) / 2);
        next.push({ key: `${edge.from}>${edge.to}`, kind: edge.kind, d: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2 - 3}` });
      }
      setLines(next);
      setSize({ width: root.scrollWidth, height: root.scrollHeight });
    };
    draw();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
    observer?.observe(root);
    return () => observer?.disconnect();
    // `shape` stands for the nodes and edges: a poll that brings the same graph does not redraw.
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!graph.nodes.length) return null;
  return (
    <div className="mb-2 rounded border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-2 text-xs" data-testid="task-graph">
      <div className="mb-2 font-semibold text-foreground">Задачи прогона: {graph.nodes.length}</div>
      <div ref={box} className="relative">
        <svg className="pointer-events-none absolute left-0 top-0" width={size.width} height={size.height} aria-hidden>
          <defs>
            {kinds.map((kind) => (
              <marker key={kind} id={`lp-task-arrow-${kind}`} viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L6,3 L0,6 z" fill={EDGE_LOOK[kind].color} />
              </marker>
            ))}
          </defs>
          {lines.map((line) => (
            <path key={line.key} d={line.d} fill="none" stroke={EDGE_LOOK[line.kind].color} strokeWidth={1.25}
              strokeDasharray={EDGE_LOOK[line.kind].dash} markerEnd={`url(#lp-task-arrow-${line.kind})`} data-testid={`task-edge-${line.key}`} />
          ))}
        </svg>
        <div className="relative space-y-5">
          {rows.map((row, index) => (
            <div key={index} data-testid={`task-step-${index}`}>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {index === 0 ? "Сейчас" : `Шаг ${index + 1}`}{row.length > 1 ? " · параллельно" : ""}
              </div>
              <div className="flex flex-wrap gap-2">
                {row.map((node) => (
                  <button
                    key={node.id}
                    ref={(element) => { if (element) chips.current.set(node.id, element); else chips.current.delete(node.id); }}
                    type="button"
                    title={`${node.title} — ${STATE_LABEL[node.state]}`}
                    data-testid={`task-node-${node.id}`}
                    disabled={!node.threadId || !onOpen}
                    onClick={() => onOpen?.(node)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded border border-[var(--lp-hairline)] bg-background px-2 py-1 text-left text-foreground enabled:cursor-pointer enabled:hover:bg-state-hover disabled:cursor-default"
                  >
                    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${node.state === "running" ? "animate-pulse bg-primary" : node.state === "blocked" ? "bg-destructive" : "bg-muted-foreground/50"}`} />
                    <span className="truncate">{node.id}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {kinds.length ? (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground" data-testid="task-graph-legend">
          {kinds.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1">
              <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={EDGE_LOOK[kind].color} strokeWidth="1.5" strokeDasharray={EDGE_LOOK[kind].dash} /></svg>
              {EDGE_LOOK[kind].label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
