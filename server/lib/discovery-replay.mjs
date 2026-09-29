/* 真实搜索回放只保留核查所需的短来源信息；整条路线来源不冒充逐段来源。 */
export function replayCandidate(candidate) {
  return {
    kind: candidate.kind,
    legs: candidate.legs.map((leg) => ({
      from: leg.from, to: leg.to, mode: leg.mode_guess, via: leg.via,
      evidence_state: leg.evidence_state || 'explore',
      lead_query: leg.lead_query || null,
      evidence_note: leg.evidence_note || null,
      sources: (leg.sources || []).map((source) => ({
        title: source.title, link: source.link, sampled_at: source.sampled_at,
        connection_excerpt: source.connection_excerpt || null,
        relevance: source.relevance || null
      }))
    })),
    reason: candidate.explanation,
    basis: candidate.basis
  };
}
