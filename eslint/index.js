import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

import base from './base.js';
import importsLayer from './imports.js';
import tests from './tests.js';
import typescript from './typescript.js';

/**
 * The composed ruleset. First-party baselines are extended, not duplicated:
 * @eslint/js recommended and typescript-eslint's strict + stylistic
 * type-checked presets. Everything a third-party shared config would have
 * supplied is owned explicitly in the four files here: base.js carries the
 * Airbnb-guide selections, typescript.js the house tunings and additions,
 * imports.js and tests.js the rest. The Prettier config comes last so any
 * formatting-adjacent rule a baseline ever activates is switched off.
 *
 * Portable: no repo paths live here. Consumers supply file scoping, ignores,
 * and the type-aware parser options.
 */
export default [
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  base,
  typescript,
  importsLayer,
  tests,
  eslintConfigPrettier,
];
