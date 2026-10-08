# @lane-pilot/i18n

`t(key)`, locale detection (`detectLocale`, `localeFromSources`, `setLocaleOverride`), `unappliedReason`,
`validationMessage` and the dictionaries: the chrome dictionary in `i18n.ts` and ten partial ones
(`i18n-*.ts`, one is generated into `i18n-fields.ts` by `scripts/generate-ui-catalog.py`). `en` and `ru` are the
spread of all of them; the type of `ru` is `{ [K in keyof typeof en]: string }`, so a missing translation does not compile.

`packages/i18n/tests` fails when a key is defined in two partial dictionaries (the later spread would hide the first).
Depends on `@lane-pilot/settings-catalog`. Browser and server use it.
