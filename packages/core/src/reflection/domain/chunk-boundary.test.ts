import { describe, expect, it } from 'vitest';

import {
  CHUNK_BOUNDARY_POLICY,
  decideChunkSeal,
  type ChunkBoundaryPolicy,
  type ChunkCandidate,
} from './chunk-boundary.js';
import { chunkMemberUnits, joinedUnits, type ChunkMemberText } from './chunk-render.js';

const NOW = new Date('2026-09-09T12:00:00.000Z');

function memberText(sourceId: string, text: string): ChunkMemberText {
  return { sourceId, occurredAt: NOW, text, parts: [{ address: sourceId, text }] };
}

function candidate(sourceId: string, order: number, text: string): ChunkCandidate {
  return {
    sourceId,
    captureOrderValue: String(order).padStart(16, '0'),
    occurredAt: NOW,
    admission: { status: 'renderable' },
    text: memberText(sourceId, text),
  };
}

function suppressed(sourceId: string, order: number): ChunkCandidate {
  return {
    sourceId,
    captureOrderValue: String(order).padStart(16, '0'),
    occurredAt: NOW,
    admission: { status: 'suppressed' },
  };
}

function sealed(decision: ReturnType<typeof decideChunkSeal>): readonly string[] {
  return decision.action === 'seal' ? decision.members.map((member) => member.sourceId) : [];
}

describe('the seal decision', () => {
  it('waits while an open session stays inside every bound', () => {
    const decision = decideChunkSeal({
      remainder: [candidate('s1', 1, 'a short member')],
      now: NOW,
      sessionClosing: false,
    });
    expect(decision.action).toBe('wait');
  });

  it('seals a below-minimum tail at the session close', () => {
    const decision = decideChunkSeal({
      remainder: [candidate('s1', 1, 'one line')],
      now: NOW,
      sessionClosing: true,
    });
    expect(decision.action).toBe('seal');
    expect(sealed(decision)).toEqual(['s1']);
    if (decision.action === 'seal') {
      expect(decision.trigger).toBe('session_close');
    }
  });

  it('seals a tail whose oldest member has outlived the span', () => {
    const old = {
      ...candidate('s1', 1, 'one line'),
      occurredAt: new Date(NOW.getTime() - CHUNK_BOUNDARY_POLICY.maxSpanMs),
    };
    const decision = decideChunkSeal({ remainder: [old], now: NOW, sessionClosing: false });
    expect(decision.action).toBe('seal');
    if (decision.action === 'seal') {
      expect(decision.trigger).toBe('max_span');
    }
  });

  /**
   * The count bound is a bound on one reading, never a slice that drops sources. What the old
   * renderer did was keep the most recent `maxEpisodes` and let the rest fall out of the input
   * entirely; here the members past the bound are the next chunk's.
   */
  it('carries every source across the chunks the count bound produces', () => {
    const policy: ChunkBoundaryPolicy = { ...CHUNK_BOUNDARY_POLICY, maxMembers: 4 };
    const remainder = Array.from({ length: 5 }, (_, slot) =>
      candidate(`s${String(slot + 1)}`, slot + 1, 'tiny'),
    );
    const first = decideChunkSeal({ remainder, now: NOW, sessionClosing: false, policy });
    expect(sealed(first)).toEqual(['s1', 's2', 's3', 's4']);

    const rest = remainder.filter((member) => !sealed(first).includes(member.sourceId));
    const second = decideChunkSeal({
      remainder: rest,
      now: NOW,
      sessionClosing: true,
      policy,
    });
    expect(sealed(second)).toEqual(['s5']);
    expect([...sealed(first), ...sealed(second)].sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  /**
   * The boundary is measured on the render, so the case is stated in rendered units rather than
   * in characters: three members that exactly fill the allowance seal together, and a fourth is
   * the trigger rather than a member the render would have clipped.
   */
  it('admits an exact-allowance set and seals without the member that would exceed it', () => {
    const members = ['s1', 's2', 's3'].map((id, slot) => candidate(id, slot + 1, 'a'.repeat(200)));
    const exact = joinedUnits(
      members.map((member, index) =>
        chunkMemberUnits(index, memberText(member.sourceId, 'a'.repeat(200))),
      ),
    );
    const policy: ChunkBoundaryPolicy = { ...CHUNK_BOUNDARY_POLICY, renderedInputAllowance: exact };

    const whole = decideChunkSeal({
      remainder: members,
      now: NOW,
      sessionClosing: true,
      policy,
    });
    expect(sealed(whole)).toEqual(['s1', 's2', 's3']);

    const overflowing = decideChunkSeal({
      remainder: [...members, candidate('s4', 4, 'a'.repeat(200))],
      now: NOW,
      sessionClosing: false,
      policy,
    });
    expect(sealed(overflowing)).toEqual(['s1', 's2', 's3']);
    if (overflowing.action === 'seal') {
      expect(overflowing.trigger).toBe('rendered_input_allowance');
    }
  });

  it('seals an oversized member alone, ahead of everything behind it', () => {
    const big: ChunkCandidate = {
      ...candidate('s1', 1, 'a'.repeat(100)),
      admission: { status: 'isolated', reason: 'oversized_member' },
    };
    const decision = decideChunkSeal({
      remainder: [big, candidate('s2', 2, 'tiny')],
      now: NOW,
      sessionClosing: false,
    });
    expect(sealed(decision)).toEqual(['s1']);
    if (decision.action === 'seal') {
      expect(decision.trigger).toBe('isolated_member');
      expect(decision.isolated?.sourceId).toBe('s1');
    }
  });

  it('closes the chunk in front of an isolating member rather than admitting it', () => {
    const unreadable: ChunkCandidate = {
      ...candidate('s2', 2, 'tiny'),
      admission: { status: 'isolated', reason: 'member_evidence_unreadable' },
    };
    const decision = decideChunkSeal({
      remainder: [candidate('s1', 1, 'tiny'), unreadable, candidate('s3', 3, 'tiny')],
      now: NOW,
      sessionClosing: false,
    });
    expect(sealed(decision)).toEqual(['s1']);
  });

  /**
   * A proved-forgotten member stays a member. It renders nothing, so it buys the chunk no
   * allowance, and the neighbours it sits beside are admitted exactly as they would have been.
   */
  it('keeps a suppressed member in the chunk and spends no allowance on it', () => {
    const one = candidate('s1', 1, 'a'.repeat(200));
    const three = candidate('s3', 3, 'a'.repeat(200));
    const exact = joinedUnits([
      chunkMemberUnits(0, memberText(one.sourceId, 'a'.repeat(200))),
      chunkMemberUnits(1, memberText(three.sourceId, 'a'.repeat(200))),
    ]);
    const policy: ChunkBoundaryPolicy = { ...CHUNK_BOUNDARY_POLICY, renderedInputAllowance: exact };
    const decision = decideChunkSeal({
      remainder: [one, suppressed('s2', 2), three],
      now: NOW,
      sessionClosing: true,
      policy,
    });
    expect(sealed(decision)).toEqual(['s1', 's2', 's3']);
  });

  it('orders members by capture position rather than by the order the read returned them', () => {
    const decision = decideChunkSeal({
      remainder: [candidate('s3', 3, 'x'), candidate('s1', 1, 'x'), candidate('s2', 2, 'x')],
      now: NOW,
      sessionClosing: true,
    });
    expect(sealed(decision)).toEqual(['s1', 's2', 's3']);
  });
});
