# aion eslint ruleset

A fully explicit ruleset in the Airbnb tradition, rebuilt for current
JavaScript and TypeScript. Every active rule is named in these four files;
nothing extends a preset or shared config. Plugin packages are imported only
for rule implementations and the parser. Destined for extraction into its own
library; nothing here references repo paths.

## Layout

- `base.js`: the JavaScript core. Airbnb's semantic canon, minus formatting
  (Prettier's job) and minus the rules that aged out.
- `typescript.js`: the TypeScript layer. The strict-type-checked and
  stylistic-type-checked rule sets from typescript-eslint 8.68.0, extracted
  and frozen explicitly, with house tunings replacing preset defaults inline,
  plus the house additions.
- `imports.js`: import discipline via eslint-plugin-import-x.
- `tests.js`: relaxations for tests, fixtures, and test support.
- `index.js`: the composition, in order.

## Departures from Airbnb, on purpose

- Formatting rules are absent wholesale: Prettier owns layout. The conflict
  check runs `eslint-config-prettier`'s CLI as a script rather than importing
  its config, since there are no formatting rules to disable.
- The for-of ban is dropped: iterators are the modern default. for-in stays
  banned.
- `no-plusplus` is dropped.
- `prefer-default-export` is inverted: named exports are the default
  (`import-x/no-default-export` at warn). Named exports survive renames,
  greps, and re-exports.
- `radix` is `as-needed`: the ES5 octal quirk is gone.
- `max-classes-per-file` is not set: error-type files legitimately hold
  several small classes.

## House rules

- `type`, never `interface` (`consistent-type-definitions`).
- Braces on every control-flow body (`curly: all`).
- Files cap at 500 lines, counting everything (`max-lines`).
- Top-level type imports only; inline `import()` type expressions are banned
  (`no-restricted-syntax: TSImportType`).
- Relative imports carry `.js` (NodeNext resolution).
- Object properties are exempt from naming format: wire schemas are
  snake_case.
- The factory-function ban stays a review-time rule: a name heuristic would
  false-positive on legitimate constructors, so it is not automated.

## Regenerating the frozen TypeScript set

```
node --input-type=module -e "
import tseslint from 'typescript-eslint';
const merged = {};
for (const cfg of [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked]) {
  Object.assign(merged, cfg.rules ?? {});
}
console.log(JSON.stringify(merged, null, 2));"
```

Diff the output against `typescript.js` after a typescript-eslint upgrade and
fold changes deliberately, never by re-extending.
