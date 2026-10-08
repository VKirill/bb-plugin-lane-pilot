export type RouteRef = { method:string; path:string; file:string; line:number };

/** HTTP routes (Express/Fastify style calls, Nuxt/Nitro server files) and bot commands declared in one file. */
export function extractRoutes(file:string, text:string):RouteRef[] {
  const routes:RouteRef[] = [];
  // A file-based page (Nuxt, Next pages/) is a screen with a route.
  const page = /(?:^|\/)pages\/(.+)\.vue$/.exec(file);
  if (page && !page[1]!.includes("__tests__")) {
    const path = `/${page[1]!}`.replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, "*$1").replace(/\[(\w+)\]/g, ":$1");
    routes.push({ method:"PAGE", path:path || "/", file, line:1 });
  }
  const nitro = /(?:^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.(?:ts|js|mjs)$/.exec(file);
  if (nitro) {
    const path = `${nitro[1] === "api" ? "/api/" : "/"}${nitro[2]!}`.replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, "*$1").replace(/\[(\w+)\]/g, ":$1");
    routes.push({ method:(nitro[3] ?? "ANY").toUpperCase(), path:path || "/", file, line:1 });
  }
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\b(?:app|router|fastify|server|instance|api|r)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/g)) {
      routes.push({ method:match[1]!.toUpperCase(), path:match[2]!, file, line:index + 1 });
    }
    for (const match of line.matchAll(/\.(command|hears|callbackQuery)\(\s*['"`]([^'"`]+)['"`]/g)) {
      routes.push({ method:match[1] === "command" ? "BOT /" : "BOT", path:match[2]!, file, line:index + 1 });
    }
  });
  return routes;
}
