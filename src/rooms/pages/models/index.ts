export { extraSettingTab } from "./placement";
export type { SettingTab } from "./placement";
export { DEPTH_TABS, LEGACY_TABS, SEGMENT_LABELS, SEGMENTS, TAB_IDS, TAB_LABELS, resolveTab, segmentsFor } from "./tabs-model";
export type { SegmentId, SegmentedTab, TabId } from "./tabs-model";
export {
  CONSOLE_SECTIONS,
  LEGACY_SCOPES,
  SECTION_VIEWS,
  STAFF_TABS,
  SYSTEM_PAGES,
  buildConsolePath,
  parseConsoleRoute,
  resolveLegacyRoute,
} from "./nav-model";
export type { ConsoleRoute, ConsoleSection, StaffTab, SystemPage } from "./nav-model";
