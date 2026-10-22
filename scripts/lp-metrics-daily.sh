#!/bin/bash
# Daily Lane Pilot stability metrics → Telegram topic BB-сервис. Runs on the hub (automation auto_-fzjydlvnow, 09:00 Europe/Madrid), read-only on the hub DB.
# Install: copy this file to ~/.config/lp-metrics/daily.sh, scripts/lp-metrics-views.sql to ~/.config/lp-metrics/views.sql , scripts/lp-morning.sql to ~/.config/lp-metrics/morning.sql and scripts/lp-wall-morning.sql to ~/.config/lp-metrics/wall-morning.sql on the hub.
# Real projects on the current version and newer only (SINCE_VERSION=X.Y.Z, default: the newest attempt's version on the hub, never below 0.1.193);
# real projects on older versions and sandbox / drill traffic are separate lines (see lp-metrics-views.sql). DRY_RUN=1 prints the text without sending it.
set -euo pipefail
[ -n "${DRY_RUN:-}" ] || . "$HOME/.config/lp-metrics/tg.env"
DB=/home/ubuntu/.bb/plugins/lane-pilot/data.db
CORE=/home/ubuntu/.bb/bb.db
VIEWS="$HOME/.config/lp-metrics/views.sql"
SINCE_VERSION="${SINCE_VERSION:-}"
[[ -z "$SINCE_VERSION" || "$SINCE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "SINCE_VERSION must look like 0.1.193" >&2; exit 2; }
q(){ { echo "attach 'file:$CORE?mode=ro' as core; create temp table lp_params(days integer, since_version text); insert into lp_params values ($1, '$SINCE_VERSION');"; cat "$VIEWS"; echo "$2"; } | sqlite3 -readonly "$DB"; }
day(){ q 1 "$1"; }
week(){ q 7 "$1"; }
since="(select ms from lp_cut)"
ver=$(day "select v from lp_floor")
win=$(week "select case when count(*)=0 then 'ещё нет реальных попыток на этой версии' else 'день '||min(7, cast((strftime('%s','now')-min(created_at)/1000)/86400 as integer)+1)||' из 7, с '||date(min(created_at)/1000,'unixepoch') end from lp_attempt where scope='real' and cur=1")
acc=$(day "select count(*)||' попыток, принято '||coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='real' and cur=1 and created_at>$since")
accw=$(week "select coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='real' and cur=1 and created_at>$since")
fault=$(day "select count(*)||' из '||(select count(*) from lp_attempt_class where scope='real' and cur=1 and cls is not null and created_at>$since) from lp_attempt_class where scope='real' and cur=1 and cls='harness' and created_at>$since")
orig=$(day "select group_concat(origin||' '||n, ', ') from (select origin, count(*) n from lp_triage where scope='real' and cur=1 and failed_at>$since group by origin order by n desc)")
orch=$(day "select coalesce(round(100.0*sum(origin='orchestrator')/nullif(count(*),0),1),0)||'%' from lp_triage where scope='real' and cur=1 and failed_at>$since")
sys=$(day "select count(*) from lp_triage where scope='real' and cur=1 and failed_at>$since and (reason like '%page_cap%' or reason like '%lost in a plugin reload%' or reason like '%illegal stage transition%' or reason like '%factory registration%' or reason like '%stale API handle%' or reason like '%not a git repository%' or reason like '%owns_paths rejected .agents/%' or reason like '%SIGKILL%')")
old=$(day "select count(*)||' попыток, принято '||coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='real' and cur=0 and created_at>$since")
sand=$(day "select count(*)||' попыток, принято '||coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='sandbox' and created_at>$since")
usage=$(week "select coalesce(group_concat(provider||' '||m||'/'||n, ', '), 'нет попыток') from (select provider, sum(measured) m, count(*) n from lp_attempt_usage where scope='real' and cur=1 and created_at>$since group by provider order by n desc)")
# The register of deferrals (src/rooms/deferral): overdue ones turn the deploy drill red; entries without a term from the owner are his morning list.
# A hub whose plugin has no such table yet gives an empty line, not an error.
now_ms="$(( $(date +%s) * 1000 ))"
dfr=$(day "select 'Отсрочки: просрочено '||coalesce(sum(state in ('open','overdue') and due_at<$now_ms),0)||', открыто '||coalesce(sum(state in ('open','overdue') and due_at>=$now_ms),0)||', нужен срок от владельца '||coalesce(sum(state='needs_owner_term'),0)||coalesce((select ' (просрочено: '||group_concat(substr(what,1,60)||' ['||id||']', '; ')||')' from (select id, what from lane_pilot_deferral where state in ('open','overdue') and due_at<$now_ms order by due_at limit 3)),'') from lane_pilot_deferral" 2>/dev/null) || dfr=""
text="📊 Lane Pilot за сутки, реальные проекты на версии ≥${ver}: ${acc} (за 7 дней ${accw}). Окно стабильности: ${win}. Вина Lane Pilot (harness): ${fault}. Провалы: ${orig:-нет}. Доля orchestrator: ${orch}. Системных причин: ${sys}. Цель: orchestrator <5%, системных 0, принято ≥60%, 7 дней подряд. Старые версии (до ${ver}), для сравнения: ${old}. Песочницы и учения отдельно: ${sand}. Токены писателей за 7 дней (измерено/попыток): ${usage}; где провайдер не отдаёт расход (acp-cursor), цена «не измерено», не 0 (bb lane-pilot metrics).${dfr:+ ${dfr}.}"
# The morning list (four lines, scripts/lp-morning.sql; the fourth is «Ещё ждут владельца», the summary of the screen «Ждут владельца»): never blocks the report;
# no file just leaves it out, and a failing line (a database without the owner-waiting tables) leaves out only itself.
now_s=$(date +%s)
morning=$( { echo "create temp table lp_morning(since integer, now integer); insert into lp_morning values ($(( (now_s - 86400) * 1000 )), $(( now_s * 1000 )));"; cat "$HOME/.config/lp-metrics/morning.sql"; } | sqlite3 -readonly "$DB" 2>/dev/null ) || true
[ -z "$morning" ] || text="${text}"$'\n\n'"${morning}"
# What the night loop did (three lines, scripts/lp-wall-morning.sql, src/rooms/wall): the same rule, a missing file or table leaves it out.
wall=$( { echo "create temp table lp_morning(since integer); insert into lp_morning values ($(( ($(date +%s) - 86400) * 1000 )));"; cat "$HOME/.config/lp-metrics/wall-morning.sql"; } | sqlite3 -readonly "$DB" 2>/dev/null ) || wall=""
[ -z "$wall" ] || text="${text}"$'\n'"${wall}"
if [ -n "${DRY_RUN:-}" ]; then echo "$text"; exit 0; fi
curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d chat_id="$TG_CHAT" -d message_thread_id="$TG_TOPIC" --data-urlencode text="$text" >/dev/null
echo "$text"
