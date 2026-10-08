-- Lane Pilot stability metrics over the last N days (default 7); run read-only by scripts/lp-metrics.sh after lp-metrics-views.sql.
-- Real projects first; sandbox and drill traffic (see the views) is one separate line and never part of a share.
.mode column
.headers on
select '== Real projects (sandbox and drills excluded)' as report;
-- Accepted share of all attempts.
select count(*) attempts, sum(state='accepted') accepted, sum(state='canceled') canceled, round(100.0*sum(state='accepted')/nullif(count(*),0),1) accepted_pct
from lp_attempt where scope='real' and created_at > (select ms from lp_cut);
-- Failed attempts (everything but accepted and canceled) by class; harness is Lane Pilot's own fault.
select cls, count(*) failed, round(100.0*count(*)/(select count(*) from lp_attempt_class where scope='real' and cls is not null and created_at > (select ms from lp_cut)),1) share_pct
from lp_attempt_class where scope='real' and cls is not null and created_at > (select ms from lp_cut) group by cls order by 2 desc;
select count(*) failed, sum(cls='harness') lp_fault, round(100.0*sum(cls='harness')/nullif(count(*),0),1) lp_fault_pct
from lp_attempt_class where scope='real' and cls is not null and created_at > (select ms from lp_cut);
-- By project.
select project, count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/count(*),1) accepted_pct, sum(cls='harness') lp_fault
from lp_attempt_class where scope='real' and created_at > (select ms from lp_cut) group by project order by 2 desc;
-- Failures by origin (the triage).
select origin, count(*) failures from lp_triage
where scope='real' and failed_at > (select ms from lp_cut) group by origin order by 2 desc;
-- System reasons that must not occur.
select substr(reason,1,60) system_reason, count(*) n from lp_triage
where scope='real' and failed_at > (select ms from lp_cut)
  and (reason like '%page_cap%' or reason like '%lost in a plugin reload%'
    or reason like '%illegal stage transition%' or reason like '%factory registration%'
    or reason like '%stale API handle%' or reason like '%not a git repository%'
    or reason like '%owns_paths rejected .agents/%' or reason like '%SIGKILL%')
group by 1 order by 2 desc;

select '== Sandbox and drills (separate)' as report;
select count(*) attempts, sum(state='accepted') accepted, round(100.0*sum(state='accepted')/nullif(count(*),0),1) accepted_pct, sum(cls='harness') lp_fault,
  count(distinct project) projects
from lp_attempt_class where scope='sandbox' and created_at > (select ms from lp_cut);
