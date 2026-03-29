import type {
  InvestmentDecisionNote,
  InvestmentDecisionRequest,
  InvestmentSourceHealth,
} from '@agentic/shared-types';
import type { ReportRunMode } from '@agentic/shared-types';
import { CandidateService } from '../collector/candidate-service.js';
import { InvestmentContextProvider } from './context-provider.js';
import { InvestableUniverseResolver } from './universe-resolver.js';

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildWindow(asOfDate: string, windowDays: number): InvestmentDecisionRequest['window'] {
  const end = new Date(`${asOfDate}T23:59:59.000Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(windowDays - 1, 0));
  return {
    label: asOfDate,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export class InvestmentSignalAssembler {
  constructor(
    private readonly candidateService: CandidateService,
    private readonly investmentContext: InvestmentContextProvider,
    private readonly resolver: InvestableUniverseResolver,
  ) {}

  async assemble(args: {
    runId: string;
    mode: ReportRunMode;
    asOfDate: string;
    watchlist: string[];
    windowDays: number;
  }): Promise<InvestmentDecisionRequest> {
    const [candidates, sourceStatus] = await Promise.all([
      this.candidateService.getEmergingCandidates(),
      this.candidateService.getSourcesStatus(),
    ]);

    const resolution = await this.resolver.resolve({
      watchlist: args.watchlist,
      candidates,
    });

    const investmentNotes: InvestmentDecisionNote[] = [];
    for (const equity of resolution.resolvedEquities) {
      const notes = await this.investmentContext.listRecentNotesForAsset(equity.asset_key, 3);
      equity.linked_notes = uniqueStrings([
        ...equity.linked_notes,
        ...notes.map((note) => note.intake_id),
      ]);
      investmentNotes.push(
        ...notes.map((note) => ({
          intake_id: note.intake_id,
          asset_key: note.asset_candidates.find((candidate) => candidate.asset_key)?.asset_key ?? null,
          title: note.investment_note.title,
          summary: note.investment_note.summary,
          why_it_might_matter: note.investment_note.why_it_might_matter,
          open_questions: note.investment_note.open_questions,
          source_submission_id: note.source_submission_id,
          created_at: note.created_at,
        })),
      );
    }

    const supportingEvidenceRefs = uniqueStrings(
      resolution.candidateClusters.flatMap((cluster) => cluster.evidence_ids),
    );

    const sourceHealthSummary: InvestmentSourceHealth[] = Object.entries(sourceStatus)
      .map(([sourceId, status]) => ({
        source_id: sourceId,
        readiness_status: status.readiness_status ?? null,
        readiness_reason: status.readiness_reason ?? null,
        quality_status: status.quality_status ?? null,
        freshness_lag_seconds: status.freshness_lag_seconds ?? null,
        last_success_at: status.last_success_at ?? null,
        last_failure_kind: status.last_failure_kind ?? null,
      }))
      .sort((left, right) => {
        if ((left.readiness_status ?? 'ready') === 'ready' && (right.readiness_status ?? 'ready') !== 'ready') {
          return 1;
        }
        if ((left.readiness_status ?? 'ready') !== 'ready' && (right.readiness_status ?? 'ready') === 'ready') {
          return -1;
        }
        return left.source_id.localeCompare(right.source_id);
      });

    return {
      run_id: args.runId,
      created_at: new Date().toISOString(),
      mode: args.mode,
      window: buildWindow(args.asOfDate, args.windowDays),
      watchlist: args.watchlist,
      resolved_equities: resolution.resolvedEquities,
      candidate_clusters: resolution.candidateClusters,
      supporting_evidence_refs: supportingEvidenceRefs,
      investment_notes: investmentNotes,
      source_health_summary: sourceHealthSummary,
      coverage_gaps: resolution.coverageGaps,
      schema_version: 1,
    };
  }
}
