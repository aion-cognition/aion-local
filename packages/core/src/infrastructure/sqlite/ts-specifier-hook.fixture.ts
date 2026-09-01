// Loaded with `--import` ahead of the worker and child-process fixtures in this directory, and
// not vitest-collected. Those fixtures run under native node's type stripping, where a relative
// `./x.js` specifier is looked for as a real file and the project writes it against `x.ts`.
// Source files reached through them therefore fail to resolve their own siblings. This maps the
// specifier back to the source when, and only when, that source is the file that exists.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const source = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(source))) {
        return { url: source.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
