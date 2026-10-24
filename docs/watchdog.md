---
title: Сторож хаба и подъём BB
updated: 2026-10-24
---

# Сторож хаба и подъём BB

`scripts/hub-watchdog.sh` стучится в BB раз в 15 секунд (`/install/version`) и поднимает зависший сервер сам. systemd поднимает упавший процесс, но не зависший: процесс жив, а дверь молчит.

| Команда | Что делает |
|---|---|
| `run` | Петля: стук, подозрение (8 молчаний подряд), «упал» в Telegram, убить зависший, подъём с удвоением паузы (30, 60, 120 с), «поднялся» |
| `status` | 0 — дверь отвечает, 1 — не отвечает, 2 — systemd не отвечает |
| `lift` | Подъём руками; если дверь отвечает, ничего не делает |
| `daily` | Подъёмы и падения по дням |
| `rotate` | Журнал `~/.lane-pilot/outages.jsonl` по дням, хранится 14 дней |
| `db-ready` | Готовность — настоящий запрос: `PRAGMA quick_check` и UTF-8 баз хаба, только чтение |
| `install` | Ставит сторож (ниже) |

> [!important] Пять подъёмов за час
> Если за час было пять подъёмов, сторож больше не поднимает и пишет в Telegram: «нужен человек». Бесконечный подъём прячет поломку.

Один сторож за раз: файл-замок `~/.lane-pilot/hub-watchdog.lock`. Учение — `scripts/lp-drill.sh --scenario watchdog` (сухой режим `LP_WATCH_DRY=1`: пишет в журнал, ничего не перезапускает).

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
