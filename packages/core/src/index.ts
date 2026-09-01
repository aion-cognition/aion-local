/**
 * The package entrypoint. Every export is re-exported from the layer that owns it, so this
 * file names the layers and nothing else; a symbol's home is the layer barrel next to it.
 *
 * A layer barrel carries only what something outside core imports, a line the scan in
 * `barrel-consumers.test.ts` holds. Everything a barrel does not name is still reachable: core
 * uses relative paths, and `package.json` publishes the `./*` subpath.
 */

export * from './infrastructure/index.js';
export * from './introspection/index.js';
export * from './plasticity/index.js';
export * from './recall/index.js';
export * from './redaction/index.js';
export * from './reflection/index.js';
export * from './session/index.js';
