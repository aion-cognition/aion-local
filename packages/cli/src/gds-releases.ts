/**
 * The graph-data-science releases this repo will fetch, keyed by the Neo4j CalVer series each one
 * is built for. Server and plugin move together: GDS is compiled against the kernel it ships
 * beside, so the series is the key rather than a preference.
 *
 * Every entry carries a digest somebody measured by downloading the asset and hashing it, and the
 * fetch refuses on a mismatch and on a series with no entry. No digest, no install: a plugin jar
 * runs unsandboxed inside the database process, and a 67 MB download over a link nobody can vouch
 * for is the last place to take a publisher's word for what arrived.
 *
 * Adding a series means downloading that release, hashing it, and putting both numbers here. It is
 * deliberately not derivable at runtime: a digest fetched from the same place as the file it
 * describes proves nothing.
 */

export type GdsRelease = {
  readonly version: string;
  readonly sha256: string;
  readonly bytes: number;
};

/**
 * `2026.07.0` is the pairing `compose.yaml` pins and the one the substrate's procedure census was
 * run against. `2026.08.1` is what Homebrew's formula installs today, measured the same way and
 * paired the same way, and it is the reason the native install can bring a brew-installed server
 * up on its own instead of stopping to ask for a jar.
 *
 * Both digests measured 2026-09-12 against the GitHub release assets.
 */
export const GDS_RELEASES: Readonly<Record<string, GdsRelease>> = {
  '2026.07': {
    version: '2026.07.0',
    sha256: 'fb21c5ddff545deda7ae3f3447834eebfa9e68f21790aea4fdff408710a48960',
    bytes: 66_843_739,
  },
  '2026.08': {
    version: '2026.08.1',
    sha256: 'c8dc6396cd3bce89fc95ad20f55d09615d931f216a693e6bee005f8163d4df4f',
    bytes: 69_544_914,
  },
};

export function gdsJarName(version: string): string {
  return `neo4j-graph-data-science-${version}.jar`;
}

export function gdsJarUrl(version: string): string {
  return `https://github.com/neo4j/graph-data-science/releases/download/${version}/${gdsJarName(version)}`;
}

export function gdsReleaseFor(serverSeries: string): GdsRelease | undefined {
  return GDS_RELEASES[serverSeries];
}
