-- Views shared by scripts/lp-metrics.sh (the full report) and the daily Telegram summary on the hub. Read-only.
-- The caller attaches the BB core database as `core` (it holds the project names) and creates the temp table `lp_params(days, since_version)`:
--   attach 'file:/home/ubuntu/.bb/bb.db?mode=ro' as core;  create temp table lp_params(days integer, since_version text);  insert into lp_params values (7, '');
--
-- Version. The headline counts attempts of the current build and newer (`cur`): harness_version >= lp_params.since_version, and with
-- an empty since_version the version of the newest attempt in the database (the running one), never below 0.1.193. Attempts before
-- 0.1.177 have harness_version NULL and are always older. Older real attempts are one separate line for comparison, so the numbers
-- describe the Lane Pilot that runs now and not the one that ran last week. `vnum` is x*1000000+y*1000+z of a dotted x.y.z.
--
-- Scope. Sandbox and drill traffic is not the product's: proj_3tb652jpsi, every project named «LP sandbox …» or «LP native …», and the
-- drill tasks (`drill-*`, scripts/lp-drill.sh). It is counted in its own line; every other project is `real`.
-- Class. `cls` mirrors failureClass() of src/failure-class.ts for a failed attempt (tests/lp-metrics.test.ts keeps the two equal);
-- the classes the report needs are named, everything else (task, provider, contract) is `other`.
create temp view lp_cut as select (strftime('%s', 'now') - (select days from lp_params) * 86400) * 1000 as ms;

create temp view lp_vnum as
select v, case when v glob '[0-9]*.[0-9]*.[0-9]*' then
  cast(substr(v, 1, instr(v, '.') - 1) as integer) * 1000000
  + cast(substr(substr(v, instr(v, '.') + 1), 1, instr(substr(v, instr(v, '.') + 1), '.') - 1) as integer) * 1000
  + cast(substr(substr(v, instr(v, '.') + 1), instr(substr(v, instr(v, '.') + 1), '.') + 1) as integer)
  else -1 end as n
from (select distinct harness_version as v from lane_pilot_attempt where harness_version is not null
  union select '0.1.193' union select since_version from lp_params where since_version <> '');

-- The first version the headline counts.
create temp view lp_floor as
select case when (select since_version from lp_params) <> '' then (select n from lp_vnum where v = (select since_version from lp_params))
  else max(coalesce((select n from lp_vnum where v = (select harness_version from lane_pilot_attempt where harness_version is not null order by created_at desc limit 1)), -1),
    (select n from lp_vnum where v = '0.1.193')) end as n,
  case when (select since_version from lp_params) <> '' then (select since_version from lp_params)
  else (select v from lp_vnum where n = max(coalesce((select n from lp_vnum where v = (select harness_version from lane_pilot_attempt where harness_version is not null order by created_at desc limit 1)), -1),
    (select n from lp_vnum where v = '0.1.193')) limit 1) end as v;

create temp view lp_attempt as
select a.id, a.run_id, a.task_id, a.state, a.reason, a.created_at, a.harness_version, coalesce(vn.n, -1) as vnum,
  coalesce(vn.n, -1) >= (select n from lp_floor) as cur,
  r.project_id, coalesce(p.name, r.project_id) as project,
  case when r.project_id = 'proj_3tb652jpsi' or p.name like 'LP sandbox%' or p.name like 'LP native%' or a.task_id like 'drill-%' then 'sandbox' else 'real' end as scope,
  case when a.reason like 'retry limit % exhausted:%' then trim(substr(a.reason, instr(a.reason, 'exhausted:') + 10)) else coalesce(a.reason, '') end as t
from lane_pilot_attempt a
join lane_pilot_run r on r.id = a.run_id
left join lp_vnum vn on vn.v = a.harness_version
left join core.projects p on p.id = r.project_id;

create temp view lp_attempt_class as
select *, case when state in ('accepted', 'canceled') then null
  when t like 'verdict_block:%' then 'other'
  when t like '%needs_human%' then 'judgment'
  when t like 'run_budget_exceeded:%' or t like 'retry_budget_exhausted:%' then 'budget'
  when t like '%writer_provider_limit:%' or t like 'writer_provider_unavailable:breaker_open%' or t like 'writer_provider_unavailable:usage_window%' then 'limit'
  when t like 'writer_silent_after_nudge%' then 'other'
  when t like '%not a git repository%' or t like '%no-git mode%' or t like 'waiting_secret:%' then 'other'
  when (t like '%would be overwritten by merge%' or t like '%base checkout has uncommitted changes%') and t not like 'merge_blocked:%' then 'dirty_base'
  when t like 'merge_conflict%' or t like '%: merge_conflict%' then 'merge'
  when t like 'ownership run scope invalid: run task %: unsafe%' then 'other'
  when t like '%ENOSPC%' or t like '%no space left%' or t like '%PermissionError%' or t like '%disk_low%' or t like '%index.lock%'
    or t like '%unable to write index%' or t like '%unable to write new index%' or t like '%host is not connected%' or t like '%host offline%'
    or t like '%ECONNRESET%' or t like '%ETIMEDOUT%' or t like '%EAI_AGAIN%' or t like '%ECONNREFUSED%'
    or t like 'verification failed (%): environment: %'
    or (t not like 'verification failed (%): %' and (t like '%EACCES%' or t like '%EPERM%' or t like '%permission denied%')) then 'infra'
  when t not like 'verification failed%' and (t like '%internal_error%' or t like '%merge_failed%' or t like '%merge_queue_timeout%'
    or t like '%ownership run scope invalid%' or t like '%spawn failed%' or t like '%thread_provisioning_failed%' or t like '%EROFS%'
    or t like '%execution_packet_failed%' or t like '%snapshot_failed%' or t like '%helper_context%' or t like '%workspace path is inside%'
    or t like '%stale API handle%' or t like '%ownership git base%' or t like '%cannot compare pre-existing%' or t like '%reconcile_%'
    or t like '%attempt_worktree_%' or t like '%attempt_workspace_%' or t like '%writer reconcile%' or t like '%its retry was lost%'
    or t like '%reconcile completed on a short page%' or t like '%sticky_send_failed%' or t like '%sticky_failed%') then 'harness'
  else 'other' end as cls
from lp_attempt;

create temp view lp_triage as
select t.*, coalesce(s.scope, 'real') as scope, coalesce(s.cur, 0) as cur
from lane_pilot_failure_triage t
left join lp_attempt s on s.id = t.attempt_id;
