import "@get-bb/plugin-sdk";

/**
 * The vk/experimental core adds `bb.vk` to the plugin API; a stock BB leaves it absent. The augmentation keeps the
 * feature-detected reads typed instead of repeating `(bb as …).vk` casts at every site.
 */
declare module "@get-bb/plugin-sdk" {
  interface BbPluginApi {
    vk?: {
      instanceId?: string;
      experimental_vkOnHookTimeout?: (
        callback: (event: { hook?: unknown; timeoutMs?: unknown; threadId?: unknown; projectId?: unknown; required?: unknown }) => void | Promise<void>,
      ) => { dispose(): void };
    };
  }
}
