// Public API of settings/ui: the panels that carry settings-domain logic. The shared presentational
// controls live in the ui-shell kit; these stay because they read the native-agent surfaces.
export { AccessModePanel, ORIGIN_LABEL, PmAccessNote, RoleAccessBody, isChanged, roleSummary, useAccessView } from "./agent-access";
export type { AccessApi, RoleView } from "./agent-access";
export { OwnedSettings } from "./owned-settings";
