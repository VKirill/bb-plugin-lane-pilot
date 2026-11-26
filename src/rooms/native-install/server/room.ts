import type { Room } from "../../contracts";
import { nativeInstallSettings } from "../settings";

export const room: Room<unknown> = {
  name: "native-install",
  settings: nativeInstallSettings,
};
