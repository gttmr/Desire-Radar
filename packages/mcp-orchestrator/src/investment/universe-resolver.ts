import type {
  InvestmentCandidateCluster,
  InvestmentCoverageGap,
  InvestmentEquityMapEntry,
  ResolvedEquityCandidate,
} from '@agentic/shared-types';
import type { CollectorCandidate } from '../collector/client.js';
import type { InvestmentContextProvider } from './context-provider.js';
import { EquityMapStore } from './equity-map.js';

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
    private readonly equityMap: EquityMapStore,
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
        const mapping = await this.equityMap.resolveByAlias(label);
        if (!mapping) {
          continue;
        }
        matched = true;
        this.mergeResolved(state, mapping, {
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

  private async resolveWatchlistTicker(ticker: string): Promise<InvestmentEquityMapEntry> {
    const normalized = ticker.trim().toUpperCase();
    const mapped = await this.equityMap.resolveByTicker(normalized);
    if (mapped) {
      return mapped;
    }
    const dossier = await this.investmentContext.getAssetDossier(`stock:${normalized}`);
    return {
      asset_key: dossier?.asset.asset_key ?? `stock:${normalized}`,
      ticker: normalized,
      company_name: dossier?.asset.display_name ?? normalized,
      aliases: [],
    };
  }

  private mergeResolved(
    state: ResolutionState,
    mapped: InvestmentEquityMapEntry,
    options: {
      linkedCluster: string | null;
      watchlistMember: boolean;
      whyInScope?: string;
    },
  ): void {
    const current = state.equities.get(mapped.asset_key);
    const merged: ResolvedEquityCandidate = {
      asset_key: mapped.asset_key,
      ticker: mapped.ticker,
      company_name: mapped.company_name,
      why_in_scope:
        current?.why_in_scope ??
        options.whyInScope ??
        (options.watchlistMember ? 'watchlist member' : `resolved from ${mapped.company_name}`),
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
    state.equities.set(mapped.asset_key, merged);
  }
}
