import {
  checkCoverage,
  fetchNodeEdges,
  fetchNodeProvenance,
  findEntityMergeProposalsForNode,
  findSupersessionProposalsForNode,
  PAIRED_POSITION_TIMEOUT_MS,
  positionDrift,
  readPairedPosition,
  refusalLines,
  runSourceInspection,
  sourceOutputFor,
  sourceReadDeps,
  sourceText,
  type EntityMergeProposal,
  type NodeEdge,
  type NodeEdgePage,
  type NodeProvenance,
  type PairedPositionDeps,
  type SupersessionProposal,
} from '@aion/core';
import { MAX_DERIVATION_ROOTS } from '@aion/protocol';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { completionRefusal } from './coverage.js';
import { short } from './format.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate, type Substrate } from './substrate.js';

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

/**
 * One durable reading of a node, named from the surface that produces it. The evidence layer
 * publishes no barrel, and a command reaching around one to name a type would be the first
 * consumer to do it; the shape is the resolver's own either way.
 */
type SourceReads = ReturnType<typeof sourceReadDeps>;
type DurableReading = NonNullable<
  ReturnType<Awaited<ReturnType<SourceReads['resolver']['resolveMetadata']>>['results']['get']>
>;

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
  page: NodeEdgePage,
  supersessions: readonly SupersessionProposal[],
  merges: readonly EntityMergeProposal[],
  write: Writer,
): void {
  const { edges } = page;
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
  // An aged-out reading has no successor and no close, so every stamp below reads like a
  // current node's. Without this line the word above looks like the substrate contradicting
  // itself rather than a measurement whose clock ran out.
  if (provenance.currency === 'expired') {
    write('          past its reading horizon; nothing superseded it');
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
      // A reopened close is kept rather than removed, so the line has to say the substrate
      // stopped holding it. Without this the edge reads as a live supersession on a node the
      // stamps above report as current.
      if (edge.reopenedAt !== undefined) {
        write(`            reopened ${edge.reopenedAt.toISOString()}; this close no longer holds`);
      }
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
    write(page.complete ? '  none' : '  none on this page');
  } else {
    for (const [type, count] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      write(`  ${type.padEnd(20)} ${String(count)}`);
    }
  }
  // A page is not a census. Counting what came back as the whole neighbourhood is exactly the
  // reading this line exists to prevent, and an ancestry reader may not take it as one either.
  if (!page.complete) {
    write('  (first page only; this node has more edges than one page holds)');
  }
}

type DurableMetadata = NonNullable<DurableReading['value']>;

/**
 * What the citation records say. "Unavailable" is its own answer: no producer writes these
 * records yet, so reporting none would say the substrate looked and found nothing.
 */
function citationLine(binding: DurableMetadata['narrativeBinding']): string {
  if (binding.status === 'cited') {
    return binding.revisionIds.join(', ');
  }
  return binding.status === 'none' ? 'none' : 'the citation records could not answer';
}

/**
 * What the durable records say about a node the graph still holds.
 *
 * The block above it reads the projection: labels, stamps, and the edges that happen to be
 * resident. That is where a claim's origin is easiest to see and the first thing an eviction
 * takes away, so a node whose extraction edge is gone reads as having no origin at all. The
 * records answer the same questions from what was written down — which sources carry it, which
 * roots its ancestry ends at, which sessions it belongs to, which published revisions cite it —
 * and they say how well each of those is proved, which the graph never does.
 */
function renderDurableEvidence(
  result: DurableReading,
  drift: string | undefined,
  write: Writer,
): void {
  write('durable evidence');
  const { evidence } = result;
  const why =
    evidence.status === 'complete-for-use'
      ? ''
      : `: ${evidence.reasons.map((issue) => `${issue.field} ${issue.reason}`).join(', ')}`;
  // A position that did not hold across the whole answer is what the reader is told first, in
  // the coordinator's own words, and the reading's own state stays beside it: the records were
  // read, and what moved under them is a fact about the interval rather than a correction to
  // what they said.
  if (drift === undefined) {
    write(`  proof            ${evidence.status}${why}`);
  } else {
    write('  proof            not certified across this answer');
    write(`  publication      ${drift} while it was assembled`);
    write(`  read state       ${evidence.status}${why}`);
  }
  write(`  residency        ${result.residency}`);
  const metadata = result.value;
  if (metadata === undefined) {
    // An incomplete result may still carry a value; this one carried none, and inventing an
    // empty ancestry from that would report absence where the answer is that nobody looked.
    write('  records          nothing readable for this id');
    write('');
    return;
  }
  const { provenance, ownership, narrativeBinding } = metadata;
  write(
    `  source records   ${metadata.sources.length === 0 ? 'none recorded' : metadata.sources.join(', ')}`,
  );
  write(
    `  durable roots    ${provenance.roots.length === 0 ? 'none' : provenance.roots.join(', ')}`,
  );
  const ancestry = provenance.lineage ?? [];
  const walk = provenance.complete ? 'walked to its ends' : 'cut short of them';
  write(`  ancestry         ${String(ancestry.length)} recorded, ${walk}`);
  write(
    `  ownership        sessions=${ownership.sessions.length === 0 ? 'none' : ownership.sessions.join(', ')}` +
      ` census=${ownership.censusEstablished ? 'established' : 'absent'}` +
      ` attribution=${ownership.unknownAttribution ? 'incomplete' : 'complete'}`,
  );
  write(`  citations        ${citationLine(narrativeBinding)}`);
  if (metadata.representation !== undefined) {
    write(
      `  representation   ${metadata.representation.family}; ${metadata.representation.selection} for default recall`,
    );
    if (metadata.representation.retired !== undefined) {
      write(`  family retired   ${metadata.representation.retired.knownFrom}`);
    }
  }
  write('');
}

/**
 * What the substrate can say about an id whose graph node is not there.
 *
 * Absence from the graph is residency information and nothing more. The records still know
 * whether the id names a source this substrate accepted, whether its raw evidence is intact,
 * and whether the requested mode withholds it, so the answer says which of those it is. What
 * it no longer says is that a historical query might bring the projection back: a deleted
 * projection is not recoverable by asking about an earlier moment, and sending a reader to try
 * is worse than telling them nothing.
 */
async function renderAbsentNode(
  substrate: Substrate,
  nodeId: string,
  write: Writer,
): Promise<number> {
  const deps = sourceReadDeps({
    driver: substrate.connection().driver,
    db: substrate.db(),
    logger: substrate.logger(),
  });
  const outcome = sourceOutputFor(await runSourceInspection(deps, { id: nodeId, limit: 1 }));
  write(`no graph node for '${nodeId}'`);
  write(sourceText(outcome));
  if (outcome.status === 'source') {
    write('');
    write(`the captured source is intact; \`aion source ${nodeId}\` reads all of it`);
    return 0;
  }
  return 1;
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
      // Before any graph read. `why` answers about history, so the record that says how much
      // history the substrate covers decides whether it may answer at all; reading the graph
      // first and refusing afterwards would spend the read and refuse anyway.
      const checked = checkCoverage(substrate.db(), { now: new Date(), expiryAnnotation: true });
      if (checked.status === 'refused') {
        for (const line of refusalLines(checked.refusal)) {
          stderrWriter(line);
        }
        return 1;
      }
      const { driver } = substrate.connection();
      const position: PairedPositionDeps = {
        driver,
        db: substrate.db(),
        timeoutMs: PAIRED_POSITION_TIMEOUT_MS,
      };
      const held = await readPairedPosition(position);
      const provenance = await fetchNodeProvenance(driver, flags.nodeId);
      if (provenance === undefined) {
        return await renderAbsentNode(substrate, flags.nodeId, write);
      }

      const page = await fetchNodeEdges(driver, flags.nodeId);
      const supersessions = findSupersessionProposalsForNode(substrate.db(), flags.nodeId);
      const merges = findEntityMergeProposalsForNode(substrate.db(), flags.nodeId);
      // Read under the context the coverage decision above produced, and judged against the
      // matched pair the publication layer certifies on: a resolver handed a bare mode has no
      // epoch to answer under, and one handed no position reports a reading nobody stood behind
      // as complete for use. The position is read, never taken, so an inspection acquires no
      // lock, recovers nothing and bootstraps nothing; a publication in flight degrades this
      // answer rather than blocking it.
      const reads = sourceReadDeps({
        driver,
        db: substrate.db(),
        logger: substrate.logger(),
      });
      const certified = reads.resolver.certifiedAgainst({
        checkpoint: () => Promise.resolve(held),
      });
      const batch = await certified.resolveMetadata([flags.nodeId], checked.context, {
        maxRoots: MAX_DERIVATION_ROOTS,
      });
      // The interval this answer was assembled over ends here, not at the resolver's own return:
      // a publication that landed while the command was still putting the answer together is one
      // this reading cannot claim to have been settled across.
      const drift = positionDrift(held, await readPairedPosition(position));

      // Nothing is printed until the contract this was read under is still the one in force.
      // The graph block goes with it: both halves describe one moment, and emitting either
      // under a statement that has moved is the answer the completion check exists to withhold.
      // A publication is a different matter: coverage is unchanged and valid, so the answer is
      // served with its uncertainty named rather than refused.
      const refusal = completionRefusal(substrate.db(), {
        context: checked.context,
        coverage: checked.coverage,
      });
      if (refusal !== undefined) {
        for (const line of refusalLines(refusal)) {
          stderrWriter(line);
        }
        return 1;
      }

      renderProvenance(provenance, page, supersessions, merges, write);
      // Keyed by request rather than by id, so the reading is found by the address it answers
      // for. One id was asked about, and this is the result that carries it.
      const durable = [...batch.results.values()].find(
        (result) => result.address.kind === 'id' && result.address.id === flags.nodeId,
      );
      if (durable !== undefined) {
        renderDurableEvidence(durable, drift, write);
      }
      substrate
        .logger()
        .info(
          { nodeId: flags.nodeId, edges: page.edges.length, complete: page.complete },
          'why rendered',
        );
      return 0;
    },
  });
}
