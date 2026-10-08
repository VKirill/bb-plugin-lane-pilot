import { t, type Locale } from "@lane-pilot/i18n";
import type { ViewNode } from "../view";

/** The name a node shows: its title in the owner's language, else its label, else its id; the entry and exit are named by the screen. */
export const nodeTitle = (node: ViewNode, locale: Locale): string =>
  node.kind === "start" ? t("wfKind_start") : node.kind === "end" ? t("wfKind_end") : node.title?.[locale] ?? node.label ?? node.id;
