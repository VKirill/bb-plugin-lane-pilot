# @lane-pilot/ui-kit

The building blocks of the page: the shadcn-style components (`components.json` points here), `cn()`, the
portal scope, `Disclosure`, `HelpSup`, `Surface`, the panel-layout rules, and the names of the realtime channel
(`@lane-pilot/ui-kit/realtime-channel`, which the server imports too).

Browser code only: no `node:` import, no import of a room. Two files do something when loaded
(`icon-extended` fills the icon registry, `overlay-trigger` listens to the input modality); they are listed in
`sideEffects` and kept whenever imported. Any room's `ui/` may use it.
