import type {
  PredictorRequest,
  PredictorResponse,
  InvestmentDecisionArtifact,
  CreateInvestmentDecisionRunResponse,
} from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';
import type { OrchestratorClient } from './orchestratorClient.js';

export type AnalysisBackend = 'orchestrator';

export interface AnalysisGateway {
  generateReport(request: PredictorRequest): Promise<PredictorResponse>;
}

function recommendationToDirection(
  recommendation: InvestmentDecisionArtifact['top_picks'][number]['recommendation'],
): 'bullish' | 'bearish' | 'neutral' {
  switch (recommendation) {
    case 'buy_now':
    case 'accumulate':
      return 'bullish';
    case 'pass':
      return 'bearish';
    case 'watch':
    default:
      return 'neutral';
  }
}

/**
 * Adapter that wraps OrchestratorClient + CollectorClient to conform
 * to the AnalysisGateway interface.
 */
export class OrchestratorGatewayAdapter implements AnalysisGateway {
  constructor(
    private readonly _orchestrator: OrchestratorClient,
    private readonly _collector: CollectorClient
  ) {}

  async generateReport(request: PredictorRequest): Promise<PredictorResponse> {
    try {
      const result = await this._orchestrator.createInvestmentDecisionRun({
        watchlist: request.tickers,
        mode: request.mode,
        detail: request.detail,
        as_of_date: request.asOfDate,
      });
      return this._mapDecisionResponse(result, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        generatedAt: new Date().toISOString(),
        detail: request.detail,
        summary: `리포트 생성 실패: ${message}`,
        marketCommentary: '',
        markdown: `> **Error**: ${message}`,
        items: [],
        risks: [],
        sources: [],
      } as PredictorResponse;
    }
  }

  private _mapDecisionResponse(
    result: CreateInvestmentDecisionRunResponse,
    request: PredictorRequest,
  ): PredictorResponse {
    const artifact = result.artifact;
    return {
      generatedAt: artifact.generated_at,
      detail: request.detail,
      summary: artifact.summary,
      marketCommentary: artifact.market_view,
      markdown: result.report.markdown,
      items: [...artifact.top_picks, ...artifact.watch_candidates, ...artifact.rejected_candidates].map((item) => ({
        ticker: item.ticker,
        headline: item.short_reason || item.why_now || item.company_name,
        direction: recommendationToDirection(item.recommendation),
        confidence: item.confidence,
        news: item.linked_clusters,
        disclosures: item.missing_information,
        bullCase: [item.thesis],
        bearCase: item.risks,
        watchPoints: item.missing_information,
        debateLog: {
          bull: {
            stance: item.thesis,
            confidence: item.confidence,
            arguments: [item.beneficiary_path],
          },
          bear: {
            stance: item.risks[0] ?? 'No explicit bear case',
            confidence: Math.max(0, 1 - item.confidence),
            arguments: item.risks,
          },
          judge: {
            verdict: item.recommendation,
            rationale: [item.why_now],
            selectedRisks: item.risks,
            selectedWatchPoints: item.missing_information,
          },
        },
      })),
      risks: artifact.risks,
      sources: [...new Set(result.request.source_health_summary.map((item) => item.source_id))],
    } as PredictorResponse;
  }
}

/**
 * Factory that builds the appropriate AnalysisGateway based on the
 * configured backend.
 */
export function createAnalysisGateway(
  backend: AnalysisBackend,
  orchestrator: OrchestratorClient,
  collector: CollectorClient
): AnalysisGateway {
  console.log(`ANALYSIS_BACKEND=${backend} — using OrchestratorGatewayAdapter`);
  return new OrchestratorGatewayAdapter(orchestrator, collector);
}
