import {
  fetchNodeEdges,
  fetchNodeProvenance,
  findEntityMergeProposalsForNode,
  findSupersessionProposalsForNode,
  type EntityMergeProposal,
  type NodeEdge,
  type NodeProvenance,
  type SupersessionProposal,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { short } from './format.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion why <node_id>`: everything the substrate can say about how one node came to be and
 * what has happened to it since. Read-only and currency-aware, so a superseded node answers
 * the same as a current one and says so, rather than looking like a miss.
 */

const SPEC: ArgSpec = {
  command: 'why',
  usage: 'aion why <node_id>',
  maxPositionals: 1,
};

export type WhyFlags = {
  readonly nodeId: string;
};

export function parseWhyFlags(argv: readonly string[]): WhyFlags {
  const { positionals } = parseArgs(SPEC, argv);
  const [nodeId] = positionals;
  if (nodeId === undefined || nodeId.trim().length === 0) {
    throw new CliUsageError(
      'why needs a node id: `aion why <node_id>` (see `aion last` or `aion search`)',
    );
  }
  return { nodeId };
}

function iso(value: Date | undefined): string | undefined {
  return value?.toISOString();
}

function isOpen(row: { readonly resolvedAt: string | null }): boolean {
  return row.resolvedAt === null;
}

/**
 * Edges the maintenance loop wrote, and the reason each one gives for existing.
 *
 * A node the loop created has no source episode, so the provenance block above it says
 * "no source episode recorded" and stops. That is true and useless: a Bridge is not extracted
 * from an episode, it is derived from two communities, and the story is on its edges. Same for
 * an orphan relink and a restored backbone link. Reading the edges is the only way to answer
 * why any of them are there.
 */
function renderDerivedEdges(edges: readonly NodeEdge[], write: Writer): void {
  const derived = edges.filter((edge) => edge.rationale !== undefined);
  if (derived.length === 0) {
    return;
  }
  write('derived associations');
  for (const edge of derived) {
    const signals = edge.signals.length === 0 ? 'unlabelled' : edge.signals.join(', ');
    write(`  ${edge.type} ${edge.outgoing ? '->' : '<-'} ${edge.otherId} (${signals})`);
    write(`    strength ${edge.strength.toFixed(3)}: ${edge.rationale ?? ''}`);
  }
  write('');
}

export function renderProvenance(
  provenance: NodeProvenance,
  edges: readonly NodeEdge[],
  supersessions: readonly SupersessionProposal[],
  merges: readonly EntityMergeProposal[],
  write: Writer,
): void {
  write(`node     ${provenance.id}`);
  write(`labels   ${provenance.labels.join(', ')}`);
  write(`content  ${provenance.content}`);
  write('');

  write(`currency  ${provenance.currency}`);
  if (provenance.supersededBy !== undefined) {
    write(
      `          superseded by ${provenance.supersededBy.id} at ${provenance.supersededBy.at.toISOString()}`,
    );
  }
  write('bitemporal stamps');
  write(`  occurred_at   ${iso(provenance.occurredAt) ?? '-'}`);
  write(`  valid_from    ${iso(provenance.validFrom) ?? '-'}`);
  write(`  valid_until   ${iso(provenance.validUntil) ?? 'open'}`);
  write(`  tx_from       ${iso(provenance.txFrom) ?? '-'}`);
  write(`  tx_until      ${iso(provenance.txUntil) ?? 'open'}`);
  write(`  forgotten_at  ${iso(provenance.forgottenAt) ?? 'not forgotten'}`);
  write('');

  write('provenance');
  const extractedFrom = edges.filter((edge) => edge.type === 'EXTRACTED_FROM' && edge.outgoing);
  if (provenance.sourceEpisodeId === undefined && extractedFrom.length === 0) {
    write('  no source episode recorded');
  } else {
    if (provenance.sourceEpisodeId !== undefined) {
      write(`  source episode     ${provenance.sourceEpisodeId}`);
    }
    for (const edge of extractedFrom) {
      const method = edge.provenance.length === 0 ? 'unrecorded' : edge.provenance.join(', ');
      write(
        `  extracted from     ${edge.otherId} (${edge.otherLabels.join(', ')}), method: ${method}`,
      );
    }
    if (provenance.extractionMethod !== undefined) {
      write(`  extraction method  ${provenance.extractionMethod}`);
    }
  }
  if (provenance.accessCount !== undefined || provenance.lastAccessed !== undefined) {
    write(
      `  mention salience   access_count=${String(provenance.accessCount ?? 0)} ` +
        `last_accessed=${iso(provenance.lastAccessed) ?? 'never'}`,
    );
  }
  write('');

  renderDerivedEdges(edges, write);

  write('supersession lineage');
  const lineage = edges.filter((edge) => edge.type === 'SUPERSEDES');
  if (lineage.length === 0) {
    write('  none');
  } else {
    for (const edge of lineage) {
      const direction = edge.outgoing ? 'supersedes' : 'superseded by';
      write(`  ${direction}  ${edge.otherId} (${edge.otherLabels.join(', ')})`);
    }
  }
  write('');

  write('open proposals');
  const openSupersessions = supersessions.filter(isOpen);
  const openMerges = merges.filter(isOpen);
  if (openSupersessions.length === 0 && openMerges.length === 0) {
    write('  none');
  } else {
    for (const proposal of openSupersessions) {
      write(
        `  supersession ${proposal.id}: would close ${short(proposal.oldId)} in favour of ` +
          `${short(proposal.newId)} (confidence ${proposal.confidence.toFixed(2)})`,
      );
    }
    for (const proposal of openMerges) {
      write(
        `  entity-merge ${proposal.id}: ${proposal.leftName} + ${proposal.rightName} ` +
          `at ${proposal.similarity.toFixed(3)}`,
      );
    }
  }
  write('');

  write('edges by type');
  const byType = new Map<string, number>();
  for (const edge of edges) {
    byType.set(edge.type, (byType.get(edge.type) ?? 0) + 1);
  }
  if (byType.size === 0) {
    write('  none');
  } else {
    for (const [type, count] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      write(`  ${type.padEnd(20)} ${String(count)}`);
    }
  }
}

export function runWhy(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseWhyFlags,
    needsGraph: 'why',
    run: async (substrate, flags) => {
      const { driver } = substrate.connection();
      const provenance = await fetchNodeProvenance(driver, flags.nodeId);
      if (provenance === undefined) {
        stderrWriter(
          `no node found for '${flags.nodeId}' (it may not exist, or may be forgotten; ` +
            '`aion search --knew-at <ts>` can look before a forget)',
        );
        return 1;
      }

      const edges = await fetchNodeEdges(driver, flags.nodeId);
      const supersessions = findSupersessionProposalsForNode(substrate.db(), flags.nodeId);
      const merges = findEntityMergeProposalsForNode(substrate.db(), flags.nodeId);

      renderProvenance(provenance, edges, supersessions, merges, write);
      substrate.logger().info({ nodeId: flags.nodeId, edges: edges.length }, 'why rendered');
      return 0;
    },
  });
}
