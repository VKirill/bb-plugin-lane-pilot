-- What the night loop did, three lines for the daily report (scripts/lp-metrics-daily.sh) and `bb lane-pilot wall morning`.
-- Read-only. The caller creates the parameter first:  create temp table lp_morning(since integer);  insert into lp_morning values (<ms>);
-- src/rooms/wall/morning.ts computes the same three lines; tests/wall/morning.test.ts keeps the two equal.
select 'Ночная петля: классов с повтором ' || (select count(*) from lane_pilot_wall_class where state = 'open' and recur7 > 0)
  || ', взято в ремонт ' || (select count(*) from lane_pilot_wall_repair where created_at >= (select since from lp_morning))
  || '; потрачено ' || printf('%.1f', round(coalesce((select spend_tokens from lane_pilot_wall_night where started_at >= (select since from lp_morning) order by started_at desc limit 1), 0) / 100000.0) / 10.0)
  || ' из ' || printf('%.1f', round(coalesce((select cap_tokens from lane_pilot_wall_night where started_at >= (select since from lp_morning) order by started_at desc limit 1), 0) / 100000.0) / 10.0)
  || ' млн токенов.';
select 'Ремонты ночи: слито ' || (select count(*) from lane_pilot_wall_repair where state = 'merged' and updated_at >= (select since from lp_morning))
  || ', adopt ' || (select count(*) from lane_pilot_wall_repair where state = 'accepted' and updated_at >= (select since from lp_morning))
  || ', hold ' || (select count(*) from lane_pilot_wall_repair where state in ('held', 'unproven') and updated_at >= (select since from lp_morning))
  || ', reject ' || (select count(*) from lane_pilot_wall_repair where state in ('rolled_back', 'red', 'rollback_pending') and updated_at >= (select since from lp_morning)) || '.';
select 'Охранник цикла: охот ' || (select count(*) from lane_pilot_wall where hunt_state <> 'none' and updated_at >= (select since from lp_morning))
  || ', в беклоге ' || (select count(*) from lane_pilot_wall where state = 'backlog')
  || ', перепрогонов ' || (select count(*) from lane_pilot_wall_rerun where state = 'dispatched' and created_at >= (select since from lp_morning))
  || ' (в списке ' || (select count(*) from lane_pilot_wall_rerun where state = 'listed' and created_at >= (select since from lp_morning)) || ').';

-- Тёмные таблицы (W32 rank 9): every lane_pilot_* table with no row in the window, named. The caller also creates
-- insert into lp_morning_30 values (<now_ms - 30*86400000>); tables with no clock are counted in full.
-- tests/sma-live.test.ts fails on a migration table missing from this union.
with dark(name) as (
  select 'lane_pilot_accepted_fact' as name where (select count(*) from lane_pilot_accepted_fact where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_activation' as name where (select count(*) from lane_pilot_activation where claimed_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_attempt' as name where (select count(*) from lane_pilot_attempt where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_attempt_change' as name where (select count(*) from lane_pilot_attempt_change where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_attempt_reasoning' as name where (select count(*) from lane_pilot_attempt_reasoning) = 0
  union all
  select 'lane_pilot_attempt_transition' as name where (select count(*) from lane_pilot_attempt_transition where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_backlog_issue' as name where (select count(*) from lane_pilot_backlog_issue where issued_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_baseline' as name where (select count(*) from lane_pilot_baseline where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_mark' as name where (select count(*) from lane_pilot_bench_mark) = 0
  union all
  select 'lane_pilot_bench_noise' as name where (select count(*) from lane_pilot_bench_noise where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_project' as name where (select count(*) from lane_pilot_bench_project where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_result' as name where (select count(*) from lane_pilot_bench_result where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_run' as name where (select count(*) from lane_pilot_bench_run where started_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_set' as name where (select count(*) from lane_pilot_bench_set where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_bench_task' as name where (select count(*) from lane_pilot_bench_task) = 0
  union all
  select 'lane_pilot_bench_verdict' as name where (select count(*) from lane_pilot_bench_verdict where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_capability' as name where (select count(*) from lane_pilot_capability where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_check_duration' as name where (select count(*) from lane_pilot_check_duration where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_checker_result' as name where (select count(*) from lane_pilot_checker_result where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_checker_run' as name where (select count(*) from lane_pilot_checker_run where started_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_council' as name where (select count(*) from lane_pilot_council where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_council_message' as name where (select count(*) from lane_pilot_council_message where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_deferral' as name where (select count(*) from lane_pilot_deferral where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_diff_hidden_audit' as name where (select count(*) from lane_pilot_diff_hidden_audit where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_failure_triage' as name where (select count(*) from lane_pilot_failure_triage where triaged_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_gate_event' as name where (select count(*) from lane_pilot_gate_event where occurred_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_handoff' as name where (select count(*) from lane_pilot_handoff where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_handoff_event' as name where (select count(*) from lane_pilot_handoff_event where occurred_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_harness' as name where (select count(*) from lane_pilot_harness where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_harness_experience' as name where (select count(*) from lane_pilot_harness_experience where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_hypothesis' as name where (select count(*) from lane_pilot_hypothesis where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_jev_receipt' as name where (select count(*) from lane_pilot_jev_receipt where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_learning_item' as name where (select count(*) from lane_pilot_learning_item where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_learning_obs' as name where (select count(*) from lane_pilot_learning_obs where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_learning_signal' as name where (select count(*) from lane_pilot_learning_signal where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_memory' as name where (select count(*) from lane_pilot_memory where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_memory_conflict' as name where (select count(*) from lane_pilot_memory_conflict) = 0
  union all
  select 'lane_pilot_memory_miss' as name where (select count(*) from lane_pilot_memory_miss where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_memory_probe' as name where (select count(*) from lane_pilot_memory_probe where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_memory_promotion' as name where (select count(*) from lane_pilot_memory_promotion where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_memory_receipt' as name where (select count(*) from lane_pilot_memory_receipt where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_model_rebench' as name where (select count(*) from lane_pilot_model_rebench where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_outage' as name where (select count(*) from lane_pilot_outage where noticed_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_owner_config' as name where (select count(*) from lane_pilot_owner_config where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_owner_item' as name where (select count(*) from lane_pilot_owner_item where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_owner_push' as name where (select count(*) from lane_pilot_owner_push) = 0
  union all
  select 'lane_pilot_phase' as name where (select count(*) from lane_pilot_phase where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_phase_part' as name where (select count(*) from lane_pilot_phase_part where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_pm_notice' as name where (select count(*) from lane_pilot_pm_notice where sent_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_project_settings' as name where (select count(*) from lane_pilot_project_settings where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_reconcile_cursor' as name where (select count(*) from lane_pilot_reconcile_cursor where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_regress_pass' as name where (select count(*) from lane_pilot_regress_pass where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_regression' as name where (select count(*) from lane_pilot_regression where found_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_rule_event' as name where (select count(*) from lane_pilot_rule_event where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_rule_promotion' as name where (select count(*) from lane_pilot_rule_promotion where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_rule_proposal' as name where (select count(*) from lane_pilot_rule_proposal where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_run' as name where (select count(*) from lane_pilot_run where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_run_goal' as name where (select count(*) from lane_pilot_run_goal where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_schedule' as name where (select count(*) from lane_pilot_schedule where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_schedule_run' as name where (select count(*) from lane_pilot_schedule_run where started_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_secret_issuance' as name where (select count(*) from lane_pilot_secret_issuance where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_setting_generation' as name where (select count(*) from lane_pilot_setting_generation) = 0
  union all
  select 'lane_pilot_skill_metric' as name where (select count(*) from lane_pilot_skill_metric where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_stage_event' as name where (select count(*) from lane_pilot_stage_event where occurred_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_stage_receipt' as name where (select count(*) from lane_pilot_stage_receipt where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_stage_return' as name where (select count(*) from lane_pilot_stage_return where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_task' as name where (select count(*) from lane_pilot_task where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_task_git_base' as name where (select count(*) from lane_pilot_task_git_base) = 0
  union all
  select 'lane_pilot_task_plan' as name where (select count(*) from lane_pilot_task_plan) = 0
  union all
  select 'lane_pilot_task_receipt' as name where (select count(*) from lane_pilot_task_receipt where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_token_cursor' as name where (select count(*) from lane_pilot_token_cursor where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_token_daily' as name where (select count(*) from lane_pilot_token_daily where CAST(strftime('%s', day) AS INTEGER) * 1000 >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall' as name where (select count(*) from lane_pilot_wall where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall_class' as name where (select count(*) from lane_pilot_wall_class where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall_entry' as name where (select count(*) from lane_pilot_wall_entry where recorded_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall_night' as name where (select count(*) from lane_pilot_wall_night where started_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall_repair' as name where (select count(*) from lane_pilot_wall_repair where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wall_rerun' as name where (select count(*) from lane_pilot_wall_rerun where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_arrival' as name where (select count(*) from lane_pilot_wf_arrival where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_draft' as name where (select count(*) from lane_pilot_wf_draft where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_draft_version' as name where (select count(*) from lane_pilot_wf_draft_version where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_effect' as name where (select count(*) from lane_pilot_wf_effect where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_event' as name where (select count(*) from lane_pilot_wf_event where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_run' as name where (select count(*) from lane_pilot_wf_run where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_step' as name where (select count(*) from lane_pilot_wf_step where updated_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_test' as name where (select count(*) from lane_pilot_wf_test where at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_wf_trigger' as name where (select count(*) from lane_pilot_wf_trigger where created_at >= (select since from lp_morning_30)) = 0
  union all
  select 'lane_pilot_world' as name where (select count(*) from lane_pilot_world) = 0
)
select case when (select count(*) from dark) = 0 then 'Тёмные таблицы: каждая писала за 30 дней.'
  else 'Тёмные таблицы (0 строк за 30 дней): ' || (select group_concat(name, ', ') from dark) || '.' end;
