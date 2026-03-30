import type {
  InvestmentCandidateCluster,
  InvestmentCoverageGap,
  NormalizedEquityIdentity,
  ResolvedEquityCandidate,
} from '@agentic/shared-types';
import type { CollectorCandidate } from '../collector/client.js';
import type { InvestmentContextProvider } from './context-provider.js';
import { EquityIdentityResolver } from './equity-identity.js';

type ResolutionState = {
  equities: Map<string, ResolvedEquityCandidate>;
  coverageGaps: InvestmentCoverageGap[];
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function asCluster(candidate: CollectorCandidate): InvestmentCandidateCluster {
  return {
    cluster_id: candidate.cluster_id ?? null,
    display_label:
      candidate.display_label?.trim() ||
      candidate.primary_entity?.trim() ||
      candidate.entity,
    candidate_kind: 'entity_cluster',
    primary_entity: candidate.primary_entity ?? candidate.entity,
    aliases: candidate.aliases ?? [],
    supporting_sources: candidate.supporting_sources ?? candidate.sources,
    supporting_terms: candidate.supporting_terms ?? [],
    theme_tags: candidate.theme_tags ?? [],
    event_summary: candidate.event_summary ?? null,
    graph_summary: candidate.graph_summary ?? null,
    evidence_ids: candidate.evidence_ids,
    emergence_score: candidate.emergence_score,
    velocity_score: candidate.velocity_score,
    status: candidate.status,
  };
}

export class InvestableUniverseResolver {
  constructor(
    private readonly identityResolver: EquityIdentityResolver,
    private readonly investmentContext: InvestmentContextProvider,
  ) {}

  async resolve(args: {
    watchlist: string[];
    candidates: CollectorCandidate[];
  }): Promise<{
    resolvedEquities: ResolvedEquityCandidate[];
    candidateClusters: InvestmentCandidateCluster[];
    coverageGaps: InvestmentCoverageGap[];
  }> {
    const clusters = args.candidates
      .slice()
      .sort((left, right) => right.emergence_score - left.emergence_score)
      .slice(0, 20)
      .map(asCluster);

    const state: ResolutionState = {
      equities: new Map<string, ResolvedEquityCandidate>(),
      coverageGaps: [],
    };

    for (const ticker of args.watchlist) {
      const mapped = await this.resolveWatchlistTicker(ticker);
      this.mergeResolved(state, mapped, {
        linkedCluster: null,
        watchlistMember: true,
      });
    }

    for (const cluster of clusters) {
      const labels = uniqueStrings([
        cluster.display_label,
        cluster.primary_entity ?? null,
        ...(cluster.aliases ?? []),
      ]);
      let matched = false;
      for (const label of labels) {
        const identity = await this.identityResolver.normalize(label);
        if (!identity.resolved) {
          continue;
        }
        matched = true;
        this.mergeResolved(state, identity, {
          linkedCluster: cluster.cluster_id ?? cluster.display_label,
          watchlistMember: false,
          whyInScope: `collector cluster: ${cluster.display_label}`,
        });
      }
      if (!matched) {
        state.coverageGaps.push({
          label: cluster.display_label,
          reason: 'No exact equity mapping found',
          linked_cluster_id: cluster.cluster_id ?? null,
          linked_note_ids: [],
        });
      }
    }

    return {
      resolvedEquities: [...state.equities.values()].sort((left, right) => {
        if (left.watchlist_member !== right.watchlist_member) {
          return left.watchlist_member ? -1 : 1;
        }
        return left.ticker.localeCompare(right.ticker);
      }),
      candidateClusters: clusters,
      coverageGaps: state.coverageGaps,
    };
  }

  private async resolveWatchlistTicker(ticker: string): Promise<NormalizedEquityIdentity> {
    const identity = await this.identityResolver.normalize(ticker);
    if (identity.resolved) {
      return identity;
    }
    const normalized = ticker.trim().toUpperCase();
    const dossier = await this.investmentContext.getAssetDossier(`stock:${normalized}`);
    const assetKey = dossier?.asset.asset_key ?? `stock:${normalized}`;
    return {
      input: ticker,
      resolved: true,
      asset_key: assetKey,
      ticker: normalized,
      company_name: dossier?.asset.display_name ?? normalized,
      market: null,
      exchange: null,
      instrument_code: null,
      aliases: [],
      normalization_source: 'dossier_fallback',
      normalization_confidence: 0.5,
    };
  }

  private mergeResolved(
    state: ResolutionState,
    mapped: NormalizedEquityIdentity,
    options: {
      linkedCluster: string | null;
      watchlistMember: boolean;
      whyInScope?: string;
    },
  ): void {
    const assetKey =
      mapped.asset_key ?? `stock:${mapped.ticker ?? mapped.company_name ?? 'unknown'}`;
    const companyName = mapped.company_name ?? mapped.ticker ?? 'unknown';
    const current = state.equities.get(assetKey);
    const merged: ResolvedEquityCandidate = {
      asset_key: assetKey,
      ticker: mapped.ticker ?? companyName,
      company_name: companyName,
      market: mapped.market,
      exchange: mapped.exchange,
      instrument_code: mapped.instrument_code,
      why_in_scope:
        current?.why_in_scope ??
        options.whyInScope ??
        (options.watchlistMember ? 'watchlist member' : `resolved from ${companyName}`),
      linked_clusters: uniqueStrings([
        ...(current?.linked_clusters ?? []),
        options.linkedCluster,
      ]),
      linked_notes: current?.linked_notes ?? [],
      watchlist_member: current?.watchlist_member ?? options.watchlistMember,
    };
    if (current && options.watchlistMember) {
      merged.watchlist_member = true;
      merged.why_in_scope = current.why_in_scope.includes('watchlist member')
        ? current.why_in_scope
        : `watchlist member; ${current.why_in_scope}`;
    }
    state.equities.set(assetKey, merged);
  }
}
