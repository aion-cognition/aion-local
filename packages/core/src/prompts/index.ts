/**
 * Every generation system prompt the workspace runs lives in this directory, one file per
 * surface, and each prompt is one exported constant named for what it asks rather than for a
 * route. `prompt-surfaces.test.ts` sweeps the directory and holds that shape.
 *
 * Surfaces used to export their text twice, under `LOCAL` and `KEYED`, from when a small local
 * model served some generation. No local route exists now: every provider the service builds
 * reports the one remote model. Three surfaces carried a genuinely different local text and the
 * rest carried an alias; the aliases are collapsed and the three texts are gone, each with a line
 * in its own file saying what stood there and why nothing could reach it.
 *
 * Parameterized surfaces export builder functions under the same convention. User-message
 * builders stay with the stage that assembles them: they are logic rather than text.
 *
 * The shared frame every surface is told before its own instructions lives in `frame.ts`, and
 * the request builder is what puts it there. A prompt file never mentions it.
 */

export { FRAME_VERSION, frameFor, frameText, type FrameRendering } from './frame.js';
