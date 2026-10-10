# ADR: доступ к базе Lane Pilot на хабе (2026-10-08)

**Контекст.** Аудит круг 3 (п.4): `~/.bb/plugins/lane-pilot/data.db` на хабе имела права 0644 под пользователем `ubuntu`; прямая запись в БД обходит любые проверки плагина.

**Решение.**
- Права `data.db*` → 0600, каталог `~/.bb/plugins/lane-pilot` → 0700 (сделано 08.10).
- Агенты (Claude Code, Codex, OpenCode, Cursor) на хабе **не запускаются**: проверено `ps` — ни одного такого процесса; треды работают на Mac mini, MacBook и OVH. Значит, прямого доступа к файлу у агентов нет.
- Единственный путь агента к данным хаба — HTTP API BB; его закрывает серверная проверка вызывающего (vk-функция ядра + отказ мутирующих RPC Lane Pilot и Env Catalog для агентов), аудит круг 3 п.1.

**Остающийся риск (принят).** Процесс BB-сервера и всё, что запущено на хабе от `ubuntu`, по-прежнему может писать в БД. Если когда-нибудь агенты будут запускаться на хабе — только под отдельным пользователем без доступа к `~/.bb`.


_Copy kept in the Lane Pilot repository (audit 2026-10-08 round 4, item 23); the decision record of the whole BB-сервис project is `docs/decisions/2026-10-08-lane-pilot-data-db-access.md` in its root. Round 4 check: `data.db`, `-shm` and `-wal` were 0600 and the directory 0700 on the hub, and no agent process ran there; the claim holds as long as the hub host is not added as a machine, so a periodic `bb host list` belongs in the drill._

_Update, later on 2026-10-08 (owner decision «убрать, держать просто»): the server caller check and the owner forms for Lane Pilot and Env Catalog RPCs were removed (`docs/rpc-callers.md`). The file permissions above and the fact that no agent runs on the hub remain the protection of `data.db`._

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architectural decisions](../decisions.md)
