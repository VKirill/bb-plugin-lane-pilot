/**
 * What the layout module uses of elkjs. tsconfig maps `elkjs/lib/elk.bundled.js` here because elkjs's own typings
 * (elk-api.d.ts) fail strict library checks; the bundler still loads the real package.
 */
export default class ELK {
  layout(graph: unknown): Promise<any>;
}
