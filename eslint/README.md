# aion eslint ruleset

A ruleset in the Airbnb tradition, rebuilt for current JavaScript and
TypeScript. The philosophy: first-party baselines are extended, third-party
guide content is owned explicitly. `@eslint/js` recommended and
typescript-eslint's strict + stylistic type-checked presets arrive as
extends and track their packages across upgrades; everything a shared config
like eslint-config-airbnb would have supplied is written out in these files
instead, so no third-party config package is a dependency. Destined for
extraction into its own library; nothing here references repo paths.

## Layout

- `base.js`: the JavaScript core. Airbnb's semantic canon, hand-picked and
  updated, minus formatting (Prettier's job) and minus the rules that aged
  out.
- `typescript.js`: house tunings that override the typescript-eslint preset
  defaults, plus house additions the presets do not activate.
- `imports.js`: import discipline via eslint-plugin-import-x.
- `tests.js`: relaxations for tests, fixtures, and test support.
- `index.js`: the composition. Baselines first, our layers after, the
  Prettier conflict config last.

## Departures from Airbnb, on purpose

- Formatting rules are absent wholesale: Prettier owns layout, and
  eslint-config-prettier closes the chain in case a baseline ever activates a
  formatting-adjacent rule.
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

## Upgrading the baselines

Preset changes arrive automatically with the packages, which is the point of
extending them. After an eslint or typescript-eslint major upgrade, run the
lint and read the release notes for preset changes; disagreements with a new
preset rule get an explicit override in `typescript.js` (or `base.js`) with a
comment saying why, never a fork of the preset.
