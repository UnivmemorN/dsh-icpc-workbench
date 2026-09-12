/**
 * Test loader: run the TypeScript sessions directly, without a transform process.
 *
 * The sources are written as ESM TypeScript with `.js` specifiers (the convention the
 * compiler emits), while the repository only contains `.ts` files. Node's own type
 * stripping executes the TypeScript as-is; this hook performs the single remaining step,
 * mapping a relative `./x.js` specifier onto the `./x.ts` source when that file exists.
 *
 * `module.registerHooks` is synchronous and in-process, so the test command needs neither a
 * transform service nor a child process. Requires Node >= 22.15 (`engines` is >= 22.19).
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Map `./x.js` -> `./x.ts` for relative specifiers whose `.ts` file exists. */
function mapSpecifier(specifier, parentURL) {
  if (!specifier.startsWith('.') || !specifier.endsWith('.js') || parentURL === undefined) {
    return specifier;
  }
  try {
    const candidate = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return candidate.href;
    }
  } catch {
    // Unresolvable candidate: leave the specifier untouched so the real error surfaces.
  }
  return specifier;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(mapSpecifier(specifier, context.parentURL), context);
  },
});
