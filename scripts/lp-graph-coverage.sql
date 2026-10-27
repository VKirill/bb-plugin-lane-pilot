-- Graph coverage, one line for the daily report (scripts/lp-metrics-daily.sh): per helper role, how many Lane Pilot threads of the last day ran outside a graph
-- (no `lanePilotWorkflowRunId` in their plugin metadata) out of all of them. Model work is meant to run as graphs; this line shows what still does not.
-- Read-only, on the hub: needs the core database attached as `core` (thread_plugin_metadata, threads).
-- The caller creates the parameter first:  create temp table lp_cover(since integer);  insert into lp_cover values (<ms>);
-- Left out: the PM chats (conductors, not work units), workspace holders (scaffolds) and the provider probes of a chat start (`helperProbe`: a check, not work). Prints nothing when there is no thread.
with t as (
  select json_extract(m.metadata_json, '$.role') as role,
         json_extract(m.metadata_json, '$.lanePilotWorkflowRunId') is null as side
  from core.thread_plugin_metadata m join core.threads th on th.id = m.thread_id
  where m.plugin_id like '%lane-pilot%'
    and (case when th.created_at > 100000000000 then th.created_at else th.created_at * 1000 end) >= (select since from lp_cover)
    and json_extract(m.metadata_json, '$.role') is not null
    and json_extract(m.metadata_json, '$.role') not in ('pm', 'workspace-provisioner')
    and json_extract(m.metadata_json, '$.helperProbe') is not 1
), per_role as (
  select role, sum(side) as outside, count(*) as total from t group by role
)
select 'Покрытие графами за сутки (потоков вне графа из всех, по ролям): '
  || (select group_concat(role || ' ' || outside || '/' || total, ', ') from (select * from per_role order by outside desc, total desc, role limit 12))
  || '; всего вне графа ' || (select sum(outside) from per_role) || ' из ' || (select sum(total) from per_role) || '.'
where exists (select 1 from t);
