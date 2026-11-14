"""What --dry-run prints: the header line and the task specs each scenario would dispatch."""
from __future__ import annotations

import json

from lp_drill.env import HUB, HUB_DB, NOGIT, SANDBOX, STAMP
from lp_drill.tasks import (note_task, task_limit, task_memory, task_moved, task_nogit, task_nogit_repo, task_provider,
                            task_reload, tasks_conflict, tasks_no_code_exit, tasks_parallel3)
from lp_drill.scenes.owner import live_press, live_word_scene

def dry_run(names: list[str], series: bool = False) -> None:
    print(f"drill {STAMP} in {SANDBOX['project']} ({SANDBOX['cwd']}), no-git {NOGIT['project']} ({NOGIT['cwd']}), hub db {HUB}:{HUB_DB}; scenarios: {', '.join(names)}")
    if "parallel3" in names:
        for spec in tasks_parallel3(SANDBOX["cwd"]):
            print(json.dumps(spec))
    cwd = SANDBOX["cwd"]
    documents = {"memory_paths": [task_memory(cwd)], "conflict": tasks_conflict(cwd), "main_moved": [task_moved(cwd)], "provider": [task_provider(cwd)], "provider_limit": [task_limit(cwd)], "reload": [task_reload(cwd)], "nogit": [task_nogit(NOGIT["cwd"])], "nogit_repo": [task_nogit_repo(NOGIT["cwd"])]}
    expects: dict[str, dict] = {}
    # What a default run prints is main's. The additions belong to the scenes that are new (revert) and to the extended forms
    # of old ones (--series for no_code_exit, LP_DRILL_LIVE_PRESS=1 for live_word).
    documents["revert"] = [note_task(f"drill-{STAMP}-revert-a", f"notes/drill/{STAMP}-revert.md", f"Drill {STAMP} revert a", cwd), note_task(f"drill-{STAMP}-revert-b", f"notes/drill/{STAMP}-revert.md", f"Drill {STAMP} revert b", cwd)]
    expects["revert"] = {"scenario": "in EXTRA (by name or --series)", "judge": "revert_judged"}
    if "plan_split" in names:  # imported here: the scene module imports the hub helpers, a default dry run stays main's
        from lp_drill.scenes.plan_split import PLAN_SPLIT_SQL, plan_split_cycle_tasks, plan_split_tasks
        documents["plan_split"] = [*plan_split_tasks(cwd).values(), *plan_split_cycle_tasks(cwd).values()]
        expects["plan_split"] = {"scenario": "in EXTRA (by name or --series task)", "judge": "plan_split_problems", "sql": PLAN_SPLIT_SQL}
    if series:
        documents["no_code_exit"] = tasks_no_code_exit(cwd, True)
        expects["no_code_exit"] = {f"drill-answer-{STAMP}": "accepted_first_attempt", f"drill-human-{STAMP}": "held_with_question", f"drill-noedit-{STAMP}": "not_accepted"}
    if live_press():
        documents["live_word"] = [note_task(f"drill-word-{STAMP}", f"drills/word-{STAMP}.md", "owner word", cwd), note_task(f"drill-word-red-{STAMP}", f"drills/word-red-{STAMP}.md", "owner word red", cwd)]
        expects["live_word"] = {"green": f"drill-word-{STAMP}: accepted after the yes button click", "red": f"drill-word-red-{STAMP}: blocked, no owner item"}
    for name in names:
        for spec in documents.get(name, []):
            print(f"scenario {name}: {json.dumps(spec)}")
        if name in expects:
            print(f"expects {name}: {json.dumps(expects[name])}")
        if name == "live_word" and live_press():
            print(f"scene live_word: {json.dumps(live_word_scene('<run id>'))}")
