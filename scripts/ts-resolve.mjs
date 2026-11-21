// Resolve hook for running the TypeScript sources directly under Node's type stripping: the sources
// import siblings as `./x.js` (for the declaration build), which map to `./x.ts` here.
//
// Why: Node can run `.ts` files directly (type stripping), but TypeScript's convention for an ESM package is to write the import as `./x.js` and let the compiler map it. Without this hook
// the end-to-end script (`npm run e2e:localnet`) could not import the sources. It is loaded with `node --import ./scripts/ts-resolve.mjs …`, adds no dependency, and changes nothing in the package.
//
// How it works: the hook retries a failed relative `.js` import as `.ts`, so a real `.js` file (a dependency's) still wins.
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
/** The resolver runs inside Node's loader thread, so it is passed as a data: module. Try the specifier as written; on failure retry a relative .js as .ts. */
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx)
  } catch (err) {
    // Only relative .js specifiers are mapped; anything else (a package, an absolute path) fails as it would have.
    if (spec.startsWith('.') && spec.endsWith('.js')) return next(spec.slice(0, -3) + '.ts', ctx)
    throw err
  }
}`),
)
