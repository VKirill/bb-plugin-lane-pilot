-- The morning list: four lines for the daily report (scripts/lp-metrics-daily.sh) and `bb lane-pilot policy morning`.
-- Read-only. The caller creates the parameters first:  create temp table lp_morning(since integer, now integer);  insert into lp_morning values (<since ms>, <now ms>);
-- The fourth line reads the deferral register and the tables of «Ждут владельца» (src/rooms/owner-waiting); a database without them fails only that line.
-- src/rooms/policy/morning.ts computes the same four lines; tests/policy/morning.test.ts keeps the two equal.
select 'Правила: на пробу ' || (select count(*) from lane_pilot_rule_event where action = 'adopted' and at >= (select since from lp_morning))
  || ', подтверждено ' || (select count(*) from lane_pilot_rule_event where action = 'confirmed' and at >= (select since from lp_morning))
  || ', ждут места ' || (select count(*) from lane_pilot_rule_proposal where state = 'proposed') || '.';
select 'Красное за ночь: ' || coalesce((select sum(n) || ' попыток (' || group_concat(state || ' ' || n, ', ') || ')' from
  (select state, count(*) as n from lane_pilot_attempt where updated_at >= (select since from lp_morning)
    and (state like '%failed%' or state in ('blocked', 'provider_error')) group by state order by state)), 'ничего') || '.'
  || case when (select count(*) from lane_pilot_regression where state = 'open' and kind = 'regression') > 0
    then ' Сломано после приёмки: ' || (select count(*) from lane_pilot_regression where state = 'open' and kind = 'regression') || ' ('
      || (select group_concat(task_id || ' ← ' || coalesce(substr(culprit_commit, 1, 8), '?'), ', ') from
        (select task_id, culprit_commit from lane_pilot_regression where state = 'open' and kind = 'regression' order by id limit 3)) || ').'
    else '' end;
select 'Принято: ' || (select count(*) from lane_pilot_attempt where state = 'accepted' and updated_at >= (select since from lp_morning)) || ' попыток.';
select 'Отсрочки: просрочено ' || (select count(*) from lane_pilot_deferral where state in ('open', 'overdue') and due_at < (select now from lp_morning) and owner_ref is not null and due_source in ('explicit', 'relative', 'weekday'))
  || ', открыто ' || (select count(*) from lane_pilot_deferral where state = 'open' and due_at >= (select now from lp_morning) and owner_ref is not null and due_source in ('explicit', 'relative', 'weekday'))
  || '. От твоих сообщений — ' || ((select count(*) from lane_pilot_owner_item where state = 'open') + (select count(*) from lane_pilot_learning_item where state = 'pending_owner')) || '.';
