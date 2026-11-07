/** Whether `depends_on` names `taskId`, either exactly or by its base id («P1» names a redispatched «P1.2»). */
export function dependsOnTask(dependsOn:readonly string[] | undefined, taskId:string):boolean {
  return (dependsOn ?? []).some((dep) => dep === taskId || (taskId.startsWith(`${dep}.`) && /^\d+$/.test(taskId.slice(dep.length + 1))));
}
