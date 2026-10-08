/** A task's name without its redispatch suffix: «P1.2», «fix-r4» and «fix» share one. */
export const taskStem = (taskId:string) => taskId.replace(/(?:\.\d+|-r\d+)$/i, "");
