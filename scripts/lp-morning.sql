-- The morning list: four lines for the daily report (scripts/lp-metrics-daily.sh) and `bb lane-pilot policy morning`.
-- Read-only. The caller creates the parameters first:  create temp table lp_morning(since integer, now integer);  insert into lp_morning values (<since ms>, <now ms>);
-- The fourth line reads the tables of «Ждут владельца» (src/rooms/owner-waiting); a database without them fails only that line.
-- src/rooms/policy/morning.ts computes the same four lines; tests/policy/morning.test.ts keeps the two equal.
select 'Только владелец: ждут решения правил — ' || (select count(*) from lane_pilot_rule_proposal where state = 'proposed')
  || ', пунктов обучения — ' || (select count(*) from lane_pilot_learning_item where state = 'pending_owner') || '.';
select 'Красное за ночь: ' || coalesce((select sum(n) || ' попыток (' || group_concat(state || ' ' || n, ', ') || ')' from
  (select state, count(*) as n from lane_pilot_attempt where updated_at >= (select since from lp_morning)
    and (state like '%failed%' or state in ('blocked', 'provider_error')) group by state order by state)), 'ничего') || '.';
select 'Принято: ' || (select count(*) from lane_pilot_attempt where state = 'accepted' and updated_at >= (select since from lp_morning))
  || ' попыток, правил на пробу ' || (select count(*) from lane_pilot_rule_event where action = 'adopted' and at >= (select since from lp_morning))
  || ', подтверждено ' || (select count(*) from lane_pilot_rule_event where action = 'confirmed' and at >= (select since from lp_morning)) || '.';
select 'Ещё ждут владельца: отсрочек без срока — ' || (select count(*) from lane_pilot_deferral where state = 'needs_owner_term' and kind <> 'memory_conflict')
  || ', просроченных — ' || (select count(*) from lane_pilot_deferral where kind <> 'memory_conflict' and state in ('open', 'overdue') and due_at < (select now from lp_morning))
  || ', конфликтов памяти — ' || (select count(*) from lane_pilot_memory_conflict where state = 'held')
  || ', от ночного цикла — ' || (select count(*) from lane_pilot_owner_item where state = 'open') || '. Подробно: экран «Ждут владельца».';
