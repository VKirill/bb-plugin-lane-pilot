-- Lane Pilot stability metrics over the last N days (default 7); run read-only by scripts/lp-metrics.sh after lp-metrics-views.sql.
-- Real projects on the current version and newer first (the headline); real projects on older versions are one line for comparison;
-- sandbox and drill traffic (see the views) is one separate line and never part of a share.
.mode column
.headers on
select '== Real projects, version >= ' || (select v from lp_floor) || ' (sandbox and drills excluded)' as report;
-- The stability window: it starts with the first real attempt on this version; the 7-day criterion counts from there.
select count(*) attempts, datetime(min(created_at) / 1000, 'unixepoch') first_attempt_utc,
  case when count(*) = 0 then 0 else cast((strftime('%s', 'now') - min(created_at) / 1000) / 86400 as integer) + 1 end window_day
from lp_attempt where scope='real' and cur=1;
-- Accepted share of all attempts.
select count(*) attempts, sum(state='accepted') accepted, sum(state='canceled') canceled, round(100.0*sum(state='accepted')/nullif(count(*),0),1) accepted_pct
from lp_attempt where scope='real' and cur=1 and created_at > (select ms from lp_cut);
-- Failed attempts (everything but accepted and canceled) by class; harness is Lane Pilot's own fault.
select cls, count(*) failed, round(100.0*count(*)/(select count(*) from lp_attempt_class where scope='real' and cur=1 and cls is not null and created_at > (select ms from lp_cut)),1) share_pct
from lp_attempt_class where scope='real' and cur=1 and cls is not null and created_at > (select ms from lp_cut) group by cls order by 2 desc;
select count(*) failed, sum(cls='harness') lp_fault, round(100.0*sum(cls='harness')/nullif(count(*),0),1) lp_fault_pct
from lp_attempt_class where scope='real' and cur=1 and cls is not null and created_at > (select ms from lp_cut);
-- By project.
select project, count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/count(*),1) accepted_pct, sum(cls='harness') lp_fault
from lp_attempt_class where scope='real' and cur=1 and created_at > (select ms from lp_cut) group by project order by 2 desc;
-- Failures by origin (the triage).
select origin, count(*) failures from lp_triage
where scope='real' and cur=1 and failed_at > (select ms from lp_cut) group by origin order by 2 desc;
-- System reasons that must not occur.
select substr(reason,1,60) system_reason, count(*) n from lp_triage
where scope='real' and cur=1 and failed_at > (select ms from lp_cut)
  and (reason like '%page_cap%' or reason like '%lost in a plugin reload%'
    or reason like '%illegal stage transition%' or reason like '%factory registration%'
    or reason like '%stale API handle%' or reason like '%not a git repository%'
    or reason like '%owns_paths rejected .agents/%' or reason like '%SIGKILL%')
group by 1 order by 2 desc;

select '== Real projects on older versions (for comparison)' as report;
select count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/nullif(count(*),0),1) accepted_pct, sum(cls='harness') lp_fault,
  round(100.0*sum(cls='harness')/nullif(sum(cls is not null),0),1) lp_fault_of_failed_pct, coalesce(min(harness_version), 'none (before 0.1.177)') oldest
from lp_attempt_class where scope='real' and cur=0 and created_at > (select ms from lp_cut);

select '== Sandbox and drills (separate)' as report;
select count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/nullif(count(*),0),1) accepted_pct, sum(cls='harness') lp_fault,
  count(distinct project) projects
from lp_attempt_class where scope='sandbox' and created_at > (select ms from lp_cut);

-- What the Jev output guard (J-11) costs: calls, characters sent to the Jev API, tokens and latency, by day and mode.
select '== Jev output guard (J-11) calls in the window' as report;
select date(at / 1000, 'unixepoch') day, mode, count(*) calls, sum(status != 'ok') failed, sum(input_chars) chars_sent,
  coalesce(sum(tokens_in), 0) tokens_in, coalesce(sum(tokens_out), 0) tokens_out, cast(avg(latency_ms) as integer) avg_latency_ms
from lane_pilot_jev_receipt where judgment = 'output.guard' and at > (select ms from lp_cut)
group by 1, 2 order by 1 desc, 2;
