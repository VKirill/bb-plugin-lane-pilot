-- What the night loop did, three lines for the daily report (scripts/lp-metrics-daily.sh) and `bb lane-pilot wall morning`.
-- Read-only. The caller creates the parameter first:  create temp table lp_morning(since integer);  insert into lp_morning values (<ms>);
-- src/rooms/wall/morning.ts computes the same three lines; tests/wall/morning.test.ts keeps the two equal.
select 'Ночная петля: классов с повтором ' || (select count(*) from lane_pilot_wall_class where state = 'open' and recur7 > 0)
  || ', взято в ремонт ' || (select count(*) from lane_pilot_wall_repair where created_at >= (select since from lp_morning))
  || '; потрачено ' || printf('%.1f', round(coalesce((select spend_tokens from lane_pilot_wall_night where started_at >= (select since from lp_morning) order by started_at desc limit 1), 0) / 100000.0) / 10.0)
  || ' из ' || printf('%.1f', round(coalesce((select cap_tokens from lane_pilot_wall_night where started_at >= (select since from lp_morning) order by started_at desc limit 1), 0) / 100000.0) / 10.0)
  || ' млн токенов.';
select 'Ремонты ночи: слито ' || (select count(*) from lane_pilot_wall_repair where state = 'merged' and updated_at >= (select since from lp_morning))
  || ', принято ' || (select count(*) from lane_pilot_wall_repair where state = 'accepted' and updated_at >= (select since from lp_morning))
  || ', держит политика (ждут вас) ' || (select count(*) from lane_pilot_wall_repair where state = 'held' and updated_at >= (select since from lp_morning))
  || ', откат ' || (select count(*) from lane_pilot_wall_repair where state in ('rolled_back', 'red') and updated_at >= (select since from lp_morning)) || '.';
select 'Охранник цикла: охот ' || (select count(*) from lane_pilot_wall where hunt_state <> 'none' and updated_at >= (select since from lp_morning))
  || ', в беклоге ' || (select count(*) from lane_pilot_wall where state = 'backlog')
  || ', перепрогонов ' || (select count(*) from lane_pilot_wall_rerun where state = 'dispatched' and created_at >= (select since from lp_morning))
  || ' (в списке ' || (select count(*) from lane_pilot_wall_rerun where state = 'listed' and created_at >= (select since from lp_morning)) || ').';
