/**
 * Two pieces of work that share no vocabulary and the same shape of team around them, plus a
 * third that shares neither. The query names the first one's subject; the second answers
 * nothing it asks and is reachable by no content match, no keyword and no traversal. What the
 * two have in common is the neighborhood: each sits beside a handful of people described in
 * almost the same terms, so their context vectors land near each other while their own text
 * does not.
 *
 * The crews are distinct nodes with distinct names on purpose. A shared node would make the
 * second memory reachable by the spread, and a hit the spread could have found says nothing
 * about resonance.
 */

export type ResonanceMember = {
  /** Distinct per world; two crews never share a node. */
  readonly name: string;
  /** The gloss the entity is embedded from, phrased world to world in the same terms. */
  readonly description: string;
};

export type ResonanceWorld = {
  readonly key: string;
  /** Its own session, so no episode reaches another through a session hub. */
  readonly session: string;
  /** Stored as one episode through the shipped intake. */
  readonly observation: string;
  readonly crew: readonly ResonanceMember[];
};

/** Names the anchor's subject and nothing else in the graph. */
export const RESONANCE_QUERY = 'how did we get checkout latency back under control';

/** Answers the query, and the only memory in the substrate that does. */
export const ANCHOR_WORLD: ResonanceWorld = {
  key: 'payments',
  session: 'gate-resonance-payments',
  observation:
    'Priya paged Marcus when checkout p95 blew out to 3.1 seconds, and the two of them recreated ' +
    'the missing index on orders.customer_id before the pager handover',
  crew: [
    {
      name: 'Priya Raman',
      description:
        'Priya Raman is the senior backend engineer who carries the payments on-call pager and ' +
        'owns the checkout path end to end',
    },
    {
      name: 'Marcus Delgado',
      description:
        'Marcus Delgado is the staff backend engineer who reviews every payments schema change ' +
        'and runs the weekly on-call handover',
    },
    {
      name: 'Wei Zhang',
      description:
        'Wei Zhang is the backend engineer who keeps the payments runbooks current and shadows ' +
        'the on-call rotation',
    },
  ],
};

/** Shares no word with the query or the anchor, and the same shape of crew as the anchor. */
export const TARGET_WORLD: ResonanceWorld = {
  key: 'fulfilment',
  session: 'gate-resonance-fulfilment',
  observation: 'the offsite seating plan put the two new hires at the same table',
  crew: [
    {
      name: 'Dana Whitfield',
      description:
        'Dana Whitfield is the senior backend engineer who carries the fulfilment on-call pager ' +
        'and owns the returns path end to end',
    },
    {
      name: 'Owen Brady',
      description:
        'Owen Brady is the staff backend engineer who reviews every fulfilment schema change and ' +
        'runs the weekly on-call handover',
    },
    {
      name: 'Ines Moreau',
      description:
        'Ines Moreau is the backend engineer who keeps the fulfilment runbooks current and ' +
        'shadows the on-call rotation',
    },
  ],
};

/**
 * The negative control: as far from the query as the target is, and surrounded by a
 * neighborhood of a different shape. Without it a threshold of zero would pass the battery.
 */
export const DISTRACTOR_WORLD: ResonanceWorld = {
  key: 'facilities',
  session: 'gate-resonance-facilities',
  observation: 'the espresso machine on the third floor needs descaling every fortnight',
  crew: [
    {
      name: 'Grounds and Facilities',
      description:
        'Grounds and Facilities is the building operations vendor that services the office ' +
        'equipment on every floor',
    },
    {
      name: 'Northside Catering',
      description:
        'Northside Catering delivers the sandwich trays for the monthly all-hands and invoices ' +
        'at the end of the quarter',
    },
  ],
};

export const RESONANCE_WORLDS: readonly ResonanceWorld[] = [
  TARGET_WORLD,
  DISTRACTOR_WORLD,
  ANCHOR_WORLD,
];

/**
 * Sessions with an episode of their own, stored between the target's session and the anchor's.
 * Sessions chain, so without them the anchor's session is two `FOLLOWS` hops from the target's
 * and the spread reaches the target inside the shipped hop budget: the battery would then be
 * measuring an exclusion rather than a discovery.
 */
export const SPACER_EPISODES: readonly {
  readonly session: string;
  readonly observation: string;
}[] = [
  {
    session: 'gate-resonance-spacer-one',
    observation: 'the design review moved to thursday afternoon',
  },
  {
    session: 'gate-resonance-spacer-two',
    observation: 'the laptop refresh order shipped on monday',
  },
];
