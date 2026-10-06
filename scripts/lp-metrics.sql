-- Lane Pilot stability metrics over the last N days (default 7); run read-only by scripts/lp-metrics.sh.
.mode column
.headers on
-- Accepted share of all attempts.
select count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/count(*),1) accepted_pct
from lane_pilot_attempt where created_at > (strftime('%s','now')-:days*86400)*1000;
-- Failures by origin.
select origin, count(*) failures from lane_pilot_failure_triage
where failed_at > (strftime('%s','now')-:days*86400)*1000 group by origin order by 2 desc;
-- System reasons that must not occur.
select substr(reason,1,60) system_reason, count(*) n from lane_pilot_failure_triage
where failed_at > (strftime('%s','now')-:days*86400)*1000
  and (reason like '%page_cap%' or reason like '%lost in a plugin reload%'
    or reason like '%illegal stage transition%' or reason like '%factory registration%'
    or reason like '%stale API handle%' or reason like '%not a git repository%'
    or reason like '%owns_paths rejected .agents/%' or reason like '%SIGKILL%')
group by 1 order by 2 desc;
