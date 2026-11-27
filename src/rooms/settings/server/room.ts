import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { listDistinctSettingKeys, type LanePilotDatabase } from "../../storage";
import { SETTINGS_REGISTRY } from "../../settings-registry";
import { loadoutRpc } from "./handlers/rpc/loadout";
import { preferencesRpc } from "./handlers/rpc/preferences";
import { roleModelsRpc } from "./handlers/rpc/role-models";
import { selectionsRpc } from "./handlers/rpc/selections";
import { settingsRpc } from "./handlers/rpc/settings";

type SettingsServices = Parameters<typeof preferencesRpc>[1]
  & Parameters<typeof settingsRpc>[1]
  & Parameters<typeof selectionsRpc>[1];

export function warnUnknownStoredSettings(db: LanePilotDatabase, warn: (message: string) => void): string[] {
  return SETTINGS_REGISTRY.warnUnknownKeys(listDistinctSettingKeys(db), warn);
}

export const room: Room<SettingsServices> = {
  name: "settings",
  rpc: (ctx: ServerCore, services: SettingsServices) => ({
    ...preferencesRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...roleModelsRpc(ctx),
    ...loadoutRpc(ctx),
  }),
  startup: (ctx: ServerCore) => {
    warnUnknownStoredSettings(ctx.db, (message) => ctx.bb.log.warn(message));
  },
};
