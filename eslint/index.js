import base from './base.js';
import importsLayer from './imports.js';
import tests from './tests.js';
import typescript from './typescript.js';

/**
 * The composed ruleset. Fully explicit: no preset or shared-config extends
 * anywhere in the chain; every active rule is named in one of the four files
 * below. Plugin packages are imported only for their rule implementations and
 * the parser. Formatting rules are absent by construction (Prettier owns
 * layout), so no conflict-disabling config is needed; the conflict check runs
 * as a script instead (see package.json lint:conflicts).
 *
 * Portable: no repo paths live here. Consumers supply file scoping, ignores,
 * and the type-aware parser options.
 */
export default [base, typescript, importsLayer, tests];
