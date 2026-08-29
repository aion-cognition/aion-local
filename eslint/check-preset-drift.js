import tseslint from 'typescript-eslint';

import typescriptLayer from './typescript.js';

/**
 * Drift guard for the frozen ruleset. The typescript.js rule list was
 * extracted from a specific typescript-eslint version; upgrading the package
 * can remove rules (a loud lint break) or add preset rules (a silent miss).
 * This script fails on both so an upgrade forces a deliberate diff instead of
 * quiet divergence. Severities and options are not compared: ours differ from
 * the presets on purpose.
 */
const ours = new Set(
  Object.keys(typescriptLayer.rules).filter((name) => name.startsWith('@typescript-eslint/')),
);

const implemented = new Set(
  Object.keys(tseslint.plugin.rules).map((name) => `@typescript-eslint/${name}`),
);

const presetActive = new Set();
for (const cfg of [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked]) {
  for (const [name, value] of Object.entries(cfg.rules ?? {})) {
    if (name.startsWith('@typescript-eslint/') && value !== 'off' && value !== 0) {
      presetActive.add(name);
    }
  }
}

const removed = [...ours].filter((name) => !implemented.has(name));
const unreviewed = [...presetActive].filter((name) => !ours.has(name));

if (removed.length === 0 && unreviewed.length === 0) {
  console.log(`preset drift: none (${ours.size} frozen rules, ${presetActive.size} preset rules)`);
  process.exit(0);
}
if (removed.length > 0) {
  console.error('rules frozen in typescript.js that the installed plugin no longer implements:');
  for (const name of removed.sort()) {
    console.error(`  ${name}`);
  }
}
if (unreviewed.length > 0) {
  console.error('preset rules the installed plugin activates that typescript.js does not name:');
  for (const name of unreviewed.sort()) {
    console.error(`  ${name}`);
  }
}
console.error('Fold each deliberately (see README), then re-run.');
process.exit(1);
