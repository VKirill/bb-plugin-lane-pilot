-- Graph coverage, one line for the daily report (scripts/lp-metrics-daily.sh): per helper role, how many Lane Pilot threads of the last day ran outside a graph
-- out of all of them. A thread ran inside a graph only when its `lanePilotWorkflowRunId` names a real `lane_pilot_wf_run` row and, when it names a step
-- (`lanePilotWorkflowStep`), a real `lane_pilot_wf_step` row of that run; a marker that points at nothing (a made-up run id) counts as outside and is
-- counted again as «с ложной меткой». Model work is meant to run as graphs; this line shows what still does not.
-- Read-only, on the hub: runs in the plugin database (lane_pilot_wf_run, lane_pilot_wf_step) with the core database attached as `core` (thread_plugin_metadata, threads).
-- The caller creates the parameter first:  create temp table lp_cover(since integer);  insert into lp_cover values (<ms>);
-- Left out: the PM chats (conductors, not work units), workspace holders (scaffolds) and the provider probes of a chat start (`helperProbe`: a check, not work). Prints nothing when there is no thread.
with t as (
  select json_extract(m.metadata_json, '$.role') as role,
         coalesce(json_extract(m.metadata_json, '$.lanePilotWorkflowRunId'), '') as run_id,
         coalesce(json_extract(m.metadata_json, '$.lanePilotWorkflowStep'), '') as step_key
  from core.thread_plugin_metadata m join core.threads th on th.id = m.thread_id
  where m.plugin_id like '%lane-pilot%'
    and (case when th.created_at > 100000000000 then th.created_at else th.created_at * 1000 end) >= (select since from lp_cover)
    and json_extract(m.metadata_json, '$.role') is not null
    and json_extract(m.metadata_json, '$.role') not in ('pm', 'workspace-provisioner')
    and json_extract(m.metadata_json, '$.helperProbe') is not 1
), marked as (
  select role, run_id,
         (run_id <> '' and exists (select 1 from lane_pilot_wf_run r where r.id = t.run_id)
           and (step_key = '' or exists (select 1 from lane_pilot_wf_step s where s.run_id = t.run_id and s.step_key = t.step_key))) as inside
  from t
), per_role as (
  select role, sum(not inside) as outside, count(*) as total, sum(not inside and run_id <> '') as false_marker from marked group by role
)
select 'Покрытие графами за сутки (потоков вне графа из всех, по ролям): '
  || (select group_concat(role || ' ' || outside || '/' || total, ', ') from (select * from per_role order by outside desc, total desc, role limit 12))
  || '; всего вне графа ' || (select sum(outside) from per_role) || ' из ' || (select sum(total) from per_role)
  || case when (select sum(false_marker) from per_role) > 0 then ', из них с ложной меткой ' || (select sum(false_marker) from per_role) else '' end || '.'
where exists (select 1 from t);
