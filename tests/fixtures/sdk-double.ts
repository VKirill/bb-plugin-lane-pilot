/**
 * A stateful double of the BB SDK for room integration tests (SMA Q13): threads, environments and storage.kv answer
 * from in-memory state instead of per-test hand stubs. tests/sdk-double.test.ts checks the answers against the
 * recorded real shapes (tests/fixtures/real-shapes): the double may do less than the real SDK, never more —
 * a key the real answer does not have, or another type, fails the conformance check.
 *
 * Record the real shapes again with `npx tsx scripts/record-real-shapes.ts` when a new answer is faked here.
 */
export type DoubleThread = {
  id: string;
  projectId?: string;
  environmentId?: string | null;
  status?: string;
  title?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** What `threads.output` answers. */
  output?: string;
  /** What `threads.getPluginMetadata`/`updatePluginMetadata` read and write. */
  pluginMetadata?: Record<string, unknown>;
};

export type DoubleEnvironment = {
  id: string;
  projectId?: string;
  hostId?: string;
  path?: string;
  status?: string;
};

export function sdkDouble(seed: { threads?: DoubleThread[]; environments?: DoubleEnvironment[] } = {}) {
  const threads = new Map<string, DoubleThread>();
  const outbox = new Map<string, Array<{ message: unknown; at: number }>>();
  for (const row of seed.threads ?? []) threads.set(row.id, { status: "idle", createdAt: 0, ...row });
  const environments = new Map<string, DoubleEnvironment>(seed.environments?.map((row) => [row.id, row]) ?? []);
  const kv = new Map<string, unknown>();
  const calls: Array<{ path: string; args: unknown[] }> = [];
  const tap = (path: string, args: unknown[]) => { calls.push({ path, args }); };

  const bb = {
    storage: {
      kv: {
        get: async (key: string) => { tap("storage.kv.get", [key]); return kv.get(key) ?? null; },
        set: async (key: string, value: unknown) => { tap("storage.kv.set", [key]); kv.set(key, value); },
        delete: async (key: string) => { tap("storage.kv.delete", [key]); kv.delete(key); },
        list: async () => { tap("storage.kv.list", []); return [...kv.keys()]; },
      },
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => { tap("threads.get", [threadId]); return threads.get(threadId) ?? null; },
        list: async () => { tap("threads.list", []); return [...threads.values()]; },
        create: async (input: Record<string, unknown>) => {
          const row: DoubleThread = { id: `thr_${Math.random().toString(36).slice(2, 12)}`, status: "idle", createdAt: Date.now(), ...input };
          threads.set(row.id, row);
          tap("threads.create", [input]);
          return row;
        },
        send: async ({ threadId, ...message }: { threadId: string } & Record<string, unknown>) => {
          const row = threads.get(threadId);
          if (!row) throw new Error(`threads.send: no such thread ${threadId}`);
          const list = outbox.get(threadId) ?? [];
          list.push({ message, at: Date.now() });
          outbox.set(threadId, list);
          row.status = "running";
          tap("threads.send", [threadId, message]);
          return {};
        },
        output: async ({ threadId }: { threadId: string }) => { tap("threads.output", [threadId]); return { output: threads.get(threadId)?.output ?? "" }; },
        retry: async ({ threadId }: { threadId: string }) => { tap("threads.retry", [threadId]); },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => { tap("threads.getPluginMetadata", [threadId]); return { ...(threads.get(threadId)?.pluginMetadata ?? {}) }; },
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          const row = threads.get(threadId);
          if (!row) throw new Error(`threads.updatePluginMetadata: no such thread ${threadId}`);
          row.pluginMetadata = { ...row.pluginMetadata, ...set };
          tap("threads.updatePluginMetadata", [threadId, set]);
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => { tap("environments.get", [environmentId]); return environments.get(environmentId) ?? null; },
        list: async () => { tap("environments.list", []); return [...environments.values()]; },
      },
    },
  };
  return { bb, threads, environments, kv, calls, outbox };
}
