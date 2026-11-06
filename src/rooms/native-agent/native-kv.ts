/**
 * The KV keys of a native lane session: the selection a mention token names, the selection a chat is bound to, the env
 * contributed to its provider and the agent id it runs as. The pending composer switch key is `nativeSwitchKey`
 * (native-session.ts).
 */
export const nativeSelectionKey = (token: string) => `native-selection:${token}`;
export const nativeThreadKey = (threadId: string) => `native-thread:${threadId}`;
export const nativeEnvKey = (threadId: string) => `native-env:${threadId}`;
export const nativeAgentTypeKey = (threadId: string) => `native-agent-type:${threadId}`;
