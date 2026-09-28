/**
 * The build this process runs, read the way the service's health endpoint reads it. A process
 * started without the stamp reads as `unstamped`: one fixed value rather than a changing one, so
 * a comparison against an earlier reading never sees a change that did not happen.
 */
export function runningBuild(): string {
  return process.env.AION_BUILD_SHA ?? 'unstamped';
}
