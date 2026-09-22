---
title: Решения валидатора результата BB writer
status: active
updated: 2026-09-23
tags: [lane-pilot, validation, bb-writer]
---

# Решения валидатора результата

Приёмка возможна только при полном совпадении ожидаемого результата, проверок и receipt. Любая неоднозначность, ошибка снимка или конфликт означает отказ в приёмке.

| Вход / условие | Решение | Основание и тест |
|---|---|---|
| Изменённый файл вне `owns_paths` | `validation_failed` | [`pipeline.test.ts`](../tests/pipeline.test.ts): `fails a dirty path outside owns_paths` |
| Изменённый файл совпал с `never_touch` | `validation_failed` | [`pipeline.test.ts`](../tests/pipeline.test.ts): `reports never_touch as validation_failed even when expected output is missing` |
| Файл был грязным до spawn; SHA-256 содержимого изменился, а путь запрещён или не принадлежит `owns_paths` | `validation_failed` | [`pipeline.test.ts`](../tests/pipeline.test.ts): `rejects a pre-dirty never_touch file when its content changes again` |
| Не создан один из нескольких ожидаемых файлов | `validation_failed` | [`pipeline.test.ts`](../tests/pipeline.test.ts): `fails validation when only some expected outputs are missing` |
| Ни один ожидаемый файл не создан в текущей попытке | `empty_output` | [`pipeline.test.ts`](../tests/pipeline.test.ts): `rejects a pre-existing expected file that this attempt did not produce` |
| Receipt содержит противоречивые сигналы (например, `accepted: true` вместе с failed status или ненулевым exit) | `blocked`; принимать нельзя | [`pipeline.test.ts`](../tests/pipeline.test.ts): `blocks a conflicting failed receipt even when accepted is true` |
| Невозможно получить или разобрать снимок dirty-файлов | Отказать до spawn либо отметить `validation_failed` после spawn; никогда не принимать | [`writer-validate.test.ts`](../tests/writer-validate.test.ts): `does not spawn when the dirt snapshot fails` |
| Upstream `acceptance.json` не соответствует схеме acceptance-v2 | Не публиковать как принятое; генератор выбрасывает ошибку и состояние остаётся непринятым | [`acceptance-v2.test.ts`](../tests/acceptance-v2.test.ts): receipt валидируется по vendored upstream schema с 0 ошибками |

## Снимок содержимого

Для каждого пути из `git status --porcelain -z -uall` снимок содержит SHA-256 текущих байтов. `attemptProduced` сравнивает хэши до и после spawn и учитывает создание, изменение и удаление. Отсутствующий SHA в исторической записи нельзя считать доказательством изменения или отсутствия изменения: такой результат трактуется как неопределённость и не должен вести к `accepted`.

В `acceptance.json` записывается только upstream-контракт. Служебные сведения Lane Pilot хранятся отдельно в `lane-pilot-receipt.json` рядом с ним.
