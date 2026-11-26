import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { presentationFor, type ToolLocale, type ToolPresentation } from "../../models/tool-presentation";

const localeByApi = new WeakMap<object, ToolLocale>();

/** Plugin start binds the locale once; every tool registered on this plugin API afterwards carries its presentation. */
export function bindToolLocale(bb: BbPluginApi, locale: ToolLocale): void {
  localeByApi.set(bb.agents, locale);
}

export const boundPresentation = (agents: object, name: string): ToolPresentation | undefined => {
  const locale = localeByApi.get(agents);
  return locale ? presentationFor(name, locale) : undefined;
};
