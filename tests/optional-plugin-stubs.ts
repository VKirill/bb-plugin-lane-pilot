/**
 * The services of the official-plugin integrations (provider-usage, provider-retry, Tasks mirror, concurrency-limit) as they
 * are on a hub without those plugins: for tests that build the writer's `services` bag by hand.
 */
export const noOptionalPlugins = {
  providerUsage: { hold: async () => null },
  providerRetry: { abandon: async () => 0, cancelQueuedRetries: async () => 0 },
  tasksMirror: { open: () => ({ running: () => undefined, thread: () => undefined, note: () => undefined, finish: () => undefined }) },
  concurrencyLimit: { hostCap: async () => null },
};
