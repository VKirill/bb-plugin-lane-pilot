---
title: Сторож хаба и подъём BB
updated: 2026-10-24
---

# Сторож хаба и подъём BB

`scripts/hub-watchdog.sh` стучится в BB раз в 15 секунд (`/install/version`) и поднимает зависший сервер сам. systemd поднимает упавший процесс, но не зависший: процесс жив, а дверь молчит.

| Команда | Что делает |
|---|---|
| `run` | Петля: стук (при наличии bb — тем же запросом `bb thread list --json`, что и окно), подозрение (3 отказа подряд или 8 таймаутов), «упал» в Telegram, убить зависший, подъём с паузой по журналу (30, 60, 120 с), «поднялся» или «ложная тревога», если отвечает тот же процесс. Первый взгляд — через `LP_WATCH_FIRST_SEC` (120 с) после старта |
| `status` | 0 — дверь отвечает и порт держит наш процесс, 1 — не отвечает или systemd не отвечает, «process unproven» — порт держит чужой процесс |
| `stop [--force]` | Отказ, пока идёт живая работа (список попыток), пока `--force`; процесс, не ушедший за `LP_WATCH_STOP_SEC` (30 с), добивается SIGKILL — «остановлен жёстко» |
| `restart [--force]` | Тот же stop, платформенный подъём (отсоединённо), затем ожидание двери до `LP_WATCH_RESTART_WAIT_SEC` (120 с) |
| `lift [--force]` | Подъём руками; если дверь отвечает, ничего не делает |
| `daily` | Подъёмы и падения по дням |
| `rotate` | Журнал `~/.lane-pilot/outages.jsonl` по дням, хранится 14 дней |
| `db-ready` | Готовность — настоящий запрос: `PRAGMA quick_check` и UTF-8 баз хаба, только чтение |
| `outages` | Последняя авария одним блоком с временами |
| `print-unit` | Текст юнита (system/user/mac): двухминутная задержка и предел пять перезапусков в час; ничего не регистрирует |
| `selfcheck` | Проверка по списку: утилиты и глаголы; код выхода — число неудач |
| `install` | Ставит сторож (ниже) |

Коды выхода: 0 — машина в нужном состоянии, 1 — упала или неизвестно, 2 — отказ, который снимает названный флаг (`--force`).

> [!important] Пять подъёмов за час
> Если за час было пять подъёмов, сторож больше не поднимает и пишет в Telegram: «нужен человек» (или `--force`). Бесконечный подъём прячет поломку.

Дверь отвечает, а процесс не доказан: если порт держит чужой процесс, сторож говорит об этом словами и никого не убивает. Сообщения в Telegram пишутся в журнал: `message_sent` или `message_not_sent` с названной причиной (нет tg.env, пустой токен/чат, отказ Telegram). Повторный подъём сначала убивает держателя порта.

Один сторож за раз: файл-замок `~/.lane-pilot/hub-watchdog.lock` (flock; на Mac — mkdir-замок). Учение — `scripts/lp-drill.sh --scenario watchdog` (сухой режим `LP_WATCH_DRY=1`: пишет в журнал, ничего не перезапускает) и `--scenario outage_live` (живое: подставная служба `lp-drill-door` и подставной бот).

## Linux (хаб, OVH)

```bash
bash scripts/hub-watchdog.sh install
```

- С `sudo` — служба `lp-hub-watchdog.service` (Restart=always, после `bb-server`).
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
