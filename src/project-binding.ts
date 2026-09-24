export type ProjectSourceBinding = {
  id?: string;
  hostId: string;
  path: string;
  isDefault?: boolean;
  projectId?: string;
};

export type ReadyEnvironment = {
  id: string;
  hostId: string;
  path: string | null;
  status: string;
  projectId?: string | null;
};

export type WriterBindingResolution =
  | { status: "resolved"; hostId: string; path: string; source: "session" | "unique_source" | "explicit_override"; bindingId?: string }
  | { status: "ambiguous"; bindings: ProjectSourceBinding[] }
  | { status: "setup_required" }
  | { status: "offline"; hostId: string; path: string };

function samePair(left: { hostId: string; path: string }, right: { hostId: string; path: string }): boolean {
  return left.hostId === right.hostId && left.path === right.path;
}

function sourceForPair(sources: ProjectSourceBinding[], hostId: string, path: string): ProjectSourceBinding | undefined {
  return sources.find((row) => samePair(row, { hostId, path }));
}

export function resolveWriterBinding(input: {
  projectId: string;
  sources: ProjectSourceBinding[];
  session?: { environmentId?: string | null; projectId?: string | null };
  environment?: ReadyEnvironment | null;
  explicit?: { hostId?: string | null; path?: string | null };
  selected?: { hostId: string; path: string } | null;
}): WriterBindingResolution {
  const sources = input.sources.filter((row) => row.hostId && row.path.startsWith("/") && (!row.projectId || row.projectId === input.projectId));
  const explicitHost = input.explicit?.hostId?.trim() || "";
  const explicitPath = input.explicit?.path?.trim() || "";
  if (explicitHost && explicitPath.startsWith("/")) {
    const matched = sourceForPair(sources, explicitHost, explicitPath);
    if (matched || (explicitHost && explicitPath)) {
      return { status: "resolved", hostId: explicitHost, path: explicitPath, source: "explicit_override", bindingId: matched?.id };
    }
  }
  if (input.selected) {
    const chosen = sourceForPair(sources, input.selected.hostId, input.selected.path);
    if (!chosen) return sources.length ? { status: "ambiguous", bindings: sources } : { status: "setup_required" };
    return { status: "resolved", hostId: chosen.hostId, path: chosen.path, source: "unique_source", bindingId: chosen.id };
  }
  const env = input.environment;
  if (input.session?.environmentId && env && env.id === input.session.environmentId) {
    const belongs = (env.projectId ?? input.session.projectId ?? null) === input.projectId
      || sources.some((row) => row.hostId === env.hostId);
    if (!belongs) {
      /* foreign environment — ignore */
    } else if (env.status !== "ready" || !env.path?.startsWith("/")) {
      if (env.hostId && env.path?.startsWith("/")) return { status: "offline", hostId: env.hostId, path: env.path };
    } else {
      const matched = sourceForPair(sources, env.hostId, env.path) ?? sources.find((row) => row.hostId === env.hostId);
      if (matched || sources.length === 0) {
        return { status: "resolved", hostId: env.hostId, path: env.path, source: "session", bindingId: matched?.id };
      }
    }
  }
  if (sources.length === 1) {
    const only = sources[0]!;
    return { status: "resolved", hostId: only.hostId, path: only.path, source: "unique_source", bindingId: only.id };
  }
  if (sources.length > 1) return { status: "ambiguous", bindings: sources };
  return { status: "setup_required" };
}
