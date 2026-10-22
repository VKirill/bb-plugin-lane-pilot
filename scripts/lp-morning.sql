-- The morning list: three lines for the daily report (scripts/lp-metrics-daily.sh) and `bb lane-pilot policy morning`.
-- Read-only. The caller creates the parameter first:  create temp table lp_morning(since integer);  insert into lp_morning values (<ms>);
-- src/rooms/policy/morning.ts computes the same three lines; tests/policy/morning.test.ts keeps the two equal.
select 'Только владелец: ждут решения правил — ' || (select count(*) from lane_pilot_rule_proposal where state = 'proposed')
  || ', пунктов обучения — ' || (select count(*) from lane_pilot_learning_item where state = 'pending_owner') || '.';
select 'Красное за ночь: ' || coalesce((select sum(n) || ' попыток (' || group_concat(state || ' ' || n, ', ') || ')' from
  (select state, count(*) as n from lane_pilot_attempt where updated_at >= (select since from lp_morning)
    and (state like '%failed%' or state in ('blocked', 'provider_error')) group by state order by state)), 'ничего') || '.'
  || case when (select count(*) from lane_pilot_regression where state = 'open' and kind = 'regression') > 0
    then ' Сломано после приёмки: ' || (select count(*) from lane_pilot_regression where state = 'open' and kind = 'regression') || ' ('
      || (select group_concat(task_id || ' ← ' || coalesce(substr(culprit_commit, 1, 8), '?'), ', ') from
        (select task_id, culprit_commit from lane_pilot_regression where state = 'open' and kind = 'regression' order by id limit 3)) || ').'
    else '' end;
select 'Принято: ' || (select count(*) from lane_pilot_attempt where state = 'accepted' and updated_at >= (select since from lp_morning))
  || ' попыток, правил на пробу ' || (select count(*) from lane_pilot_rule_event where action = 'adopted' and at >= (select since from lp_morning))
  || ', подтверждено ' || (select count(*) from lane_pilot_rule_event where action = 'confirmed' and at >= (select since from lp_morning)) || '.';
