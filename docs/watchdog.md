---
title: Сторож хаба и подъём BB
updated: 2026-11-11
---

# Сторож хаба и подъём BB

`scripts/hub-watchdog.sh` стучится в BB раз в 15 секунд (`/install/version`) и поднимает зависший сервер сам. systemd поднимает упавший процесс, но не зависший: процесс жив, а дверь молчит.

| Команда | Что делает |
|---|---|
| `run` | Петля: стук (HTTP 200 на `/install/version` — единственное, что решает «хаб отвечает»), подозрение (8 молчаний подряд любого рода, как раньше; более короткий счёт отказов в соединении — только настройка `LP_WATCH_REFUSED_AFTER`), «упал» в Telegram, убить зависший, подъём: после каждого перезапуска полная пауза 30, 60, 120 с (какую взять — по журналу), «поднялся» или «ложная тревога», если отвечает тот же процесс. Первый взгляд — сразу; задержку задаёт `LP_WATCH_FIRST_SEC` (по умолчанию 0). Запрос окна `bb thread list --json` — второе, справочное чтение (ok, auth, unknown): пишется в журнал и в `status`, но не считается молчанием и не поднимает хаб |
| `status [--force]` | 0 — дверь отвечает, 1 — не отвечает, systemd не отвечает или порт держит процесс, доказанно чужой («process unproven»; `--force` идёт дальше). Если держателя порта не прочесть, это «unknown»: пишется, отказом не считается |
| `stop [--force]` | Отказ, пока прочитана живая работа (любая открытая попытка: queued, spawn_requested, spawn_unknown, running, cancel_requested; список попыток), пока `--force`. База, которую не прочесть, — «unknown: proceeding», не отказ. Процесс, не ушедший за время остановки (по умолчанию `TimeoutStopUSec` юнита, 90 с если не прочесть; `LP_WATCH_STOP_SEC` переопределяет), добивается SIGKILL — «остановлен жёстко» |
| `restart [--force]` | Те же отказы, что у stop, затем как раньше: штатный перезапуск менеджера (`systemctl restart`), запущенный отсоединённо первым делом, пауза `LP_WATCH_RESTART_SETTLE_SEC` (10 с) и ожидание двери до `LP_WATCH_RESTART_WAIT_SEC` (120 с). Вызов из самого хаба не обрывается вместе с остановкой |
| `lift [--force]` | Подъём руками; если дверь отвечает, ничего не делает |
| `daily` | Подъёмы и падения по дням |
| `rotate` | Журнал `~/.lane-pilot/outages.jsonl` по дням, хранится 14 дней |
| `db-ready` | Готовность — настоящий запрос: `PRAGMA quick_check` и UTF-8 баз хаба, только чтение |
| `outages` | Последняя авария одним блоком с временами |
| `print-unit` | Текст юнита (system/user/mac): двухминутная задержка и предел перезапусков в час — только по настройкам (`LP_WATCH_FIRST_SEC`, `LP_WATCH_RESTART_CAP`); ничего не регистрирует |
| `selfcheck` | Проверка по списку: утилиты и глаголы; код выхода — число неудач |
| `install` | Ставит сторож (ниже) |

Коды выхода: 0 — машина в нужном состоянии, 1 — упала или неизвестно, 2 — отказ, который снимает названный флаг (`--force`).

> [!important] Пять подъёмов за час
> Если за час было пять подъёмов, сторож больше не поднимает и пишет в Telegram: «нужен человек» (или `--force`). Бесконечный подъём прячет поломку.

Дверь отвечает, а процесс не доказан: чужим считается только процесс, чей pid прочитан и чей cgroup (`/proc/<pid>/cgroup`) доказанно вне cgroup юнита (`ControlGroup`); на Mac и там, где прочесть нельзя, это «unknown». Сторож говорит об этом словами и никого не убивает. Сообщения в Telegram пишутся в журнал: `message_sent` или `message_not_sent` с названной причиной (нет tg.env, пустой токен/чат, отказ Telegram). Повторный подъём (со второй попытки) убивает держателя порта и пишет `port_holder_killed`, если ничего не задано (`LP_WATCH_KILL_HOLDER=1` по умолчанию), и только если MainPID был прочитан и не 0 и держатель доказанно вне cgroup юнита; никогда pid 1, сам сторож и его родитель; на Mac и там, где cgroup не прочесть, не убивает никого. С `LP_WATCH_KILL_HOLDER=0` держатель только называется в журнале (`port_holder_seen`), как раньше.

Один сторож за раз: файл-замок `~/.lane-pilot/hub-watchdog.lock` (flock; на Mac — mkdir-замок). Второй сторож, нашедший замок, ждёт `LP_WATCH_LOCK_HELD_SEC` (60 с; в сухом режиме не ждёт) и выходит, чтобы второй сторож не крутился вхолостую. Запрос доски (`bb thread list`) в петле делается на каждый 20-й стук (`LP_WATCH_BOARD_EVERY=20` по умолчанию; `0` — никогда; `status` показывает его всегда как справку). Он только справка: в счёт аварии не идёт, подъём не запускает, `status` не проваливает. Учение — `scripts/lp-drill.sh --scenario watchdog` (сухой режим `LP_WATCH_DRY=1`: пишет в журнал, ничего не перезапускает) и `--scenario outage_live` (живое: подставная служба `lp-drill-door` и подставной бот; запускается только по имени и только с `LP_DRILL_WATCHDOG_LIVE=1`; то же условие у живого прохода сценария `watchdog`). В полный прогон и в `--quick` `outage_live` не входит.

## Linux (хаб, OVH)

```bash
bash scripts/hub-watchdog.sh install
```

- С `sudo` — служба `lp-hub-watchdog.service` (Restart=always, после `bb-server`; предела перезапусков нет, как раньше — `LP_WATCH_RESTART_CAP=5` при установке ставит предел в час, после которого юнит остаётся в состоянии failed и хаб без сторожа). Задержку первого взгляда в две минуты включает строка `Environment=LP_WATCH_FIRST_SEC=120` в юните.
- Без прав администратора — пользовательская служба `~/.config/systemd/user/lp-hub-watchdog.service`; чтобы она жила после выхода из сессии: `loginctl enable-linger $USER`.
- Нет пользовательского systemd — строка `@reboot` в crontab.

Проверка: `systemctl status lp-hub-watchdog` (или `systemctl --user status …`), `bash scripts/hub-watchdog.sh status`.

## macOS (Mac mini, MacBook)

```bash
LP_WATCH_DOOR=http://127.0.0.1:<порт>/install/version bash scripts/hub-watchdog.sh install
```

Ставит LaunchAgent `~/Library/LaunchAgents/pro.vechkasov.lp-hub-watchdog.plist`: запуск при входе (RunAtLoad), держится живым (KeepAlive), журнал в `~/.lane-pilot/hub-watchdog.log`. Первая проверка Mac — агент виден в `launchctl list`. Демон BB на Mac сам стоит в launchd (`app.getbb.host-daemon.*`).

## Windows

Наших машин на Windows нет. Тот же цикл ставится задачей планировщика при входе:

```powershell
schtasks /Create /SC ONLOGON /TN "LP hub watchdog" /TR "bash -lc '~/lane-pilot/scripts/hub-watchdog.sh run'" /RL LIMITED
```

Без прав администратора — ярлык в `shell:startup` с той же командой.
