// Public API of native-install/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { room } from "./room";
export { stackRpc } from "./handlers/stack-rpc";
export {
  createNativeInstaller,
  experimental_vkLifecycle,
  registerNativeInstallHost,
} from "./services/native-install-lifecycle";
