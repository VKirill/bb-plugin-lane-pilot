// Public API of native-agent/ui: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { ComposerAgentBadge } from "./composer-agent-badge";
export { ComposerBoundary } from "./composer-boundary";
export { EnableLanePilotAction } from "./composer-enable";
export { HelperThreadPanel, useHelperThreadIndex } from "./helper-threads"
export { ROLE_GROUPS, originOfKeys, roleKey, roleName, rolePurpose } from "./team-model";
export type { RoleOrigin, RoleSpec } from "./team-model";
