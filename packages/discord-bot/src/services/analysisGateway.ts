import type {
  AgentSignal,
  AgentTurn,
  KnowledgeEntry,
  PredictorRequest,
  PredictorResponse,
  SignalValue,
  EvidenceBundle
} from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';
import type { OrchestratorClient } from './orchestratorClient.js';
import type { PredictorClient } from './predictorClient.js';

export type AnalysisBackend = 'predictor' | 'orchestrator';

export interface AnalysisGateway {
  generateReport(request: PredictorRequest): Promise<PredictorResponse>;
  getAgentSignals(): Promise<AgentSignal[]>;
  runAgents(agents?: string[]): Promise<AgentSignal[]>;
  listKnowledge(): Promise<KnowledgeEntry[]>;
  addKnowledge(content: string, tags?: string[]): Promise<KnowledgeEntry>;
  removeKnowledge(id: string): Promise<void>;
}

/**
 * Map an AgentTurn from the orchestrator debate into the AgentSignal
 * format expected by the bot layer.
 */
function turnToSignal(turn: AgentTurn): AgentSignal {
  const confidence = turn.response?.confidence ?? 0;
  let signal: SignalValue = 'neutral';
  if (confidence >= 0.7) signal = 'bullish';
  else if (confidence >= 0.4) signal = 'caution';
  else if (confidence > 0) signal = 'bearish';

  return {
    agent: turn.agent_name,
    signal,
    horizon: '1w',
    confidence,
    summary: turn.response?.summary ?? '',
    key_factors: turn.response?.claims?.map(c => c.claim) ?? [],
    updated_at: turn.created_at ?? new Date().toISOString()
  };
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
      // 1) Get top emerging candidates from collector
      const { candidates } = await this._collector.getEmergingCandidates();

      if (candidates.length === 0) {
        return {
          generatedAt: new Date().toISOString(),
          detail: request.detail,
          summary: '수집된 신호 후보가 없습니다. 데이터 소스 상태를 확인하세요.',
          marketCommentary: '',
          markdown: '> 수집된 신호 후보가 없습니다.',
          items: [],
          risks: [],
          sources: [],
          tickers: request.tickers
        } as PredictorResponse;
      }

      // 2) Sort by emergence_score and take top candidates
      const top = candidates
        .sort((a, b) => b.emergence_score - a.emergence_score)
        .slice(0, 20);

      // 3) Try orchestrator pipeline with timeout
      try {
        const report = await this._generateViaOrchestrator(request, top);
        if (report) return report;
      } catch {
        // Orchestrator unavailable — fall through to collector-only report
      }

      // 4) Fallback: generate report directly from collector data
      return this._generateFromCollectorData(request, top);
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
        tickers: request.tickers
      } as PredictorResponse;
    }
  }

  private async _generateViaOrchestrator(
    request: PredictorRequest,
    candidates: Array<{ entity: string; emergence_score: number; velocity_score: number; source_count: number; sources: string[] }>
  ): Promise<PredictorResponse | null> {
    const entityList = candidates.map(c => c.entity);
    const evidenceSummary = candidates
      .map(c => `${c.entity} (emergence=${c.emergence_score}, velocity=${c.velocity_score}, sources=${c.source_count})`)
      .join('\n');
    const totalSourceCount = candidates.reduce((sum, c) => sum + c.source_count, 0);

    const bundle: EvidenceBundle = {
      bundle_id: `gateway-${Date.now()}`,
      entity: entityList.join(', '),
      time_window: {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString()
      },
      evidence_items: [],
      cross_source_summary: `${candidates.length} emerging candidates across ${totalSourceCount} source hits.\n${evidenceSummary}`,
      recommended_agents: ['search_intent', 'ranking_momentum', 'synthesis'],
      quality_flags: []
    };

    // Submit evidence
    const { run_id } = await this._orchestrator.submitEvidence({
      topic: `Daily analysis ${request.asOfDate}`,
      evidence_bundle: bundle
    });

    // Run debate with timeout — abort if orchestrator is too slow
    const debatePromise = this._orchestrator.runDebate({ run_id, max_rounds: 1 });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('orchestrator_timeout')), 30_000)
    );
    await Promise.race([debatePromise, timeoutPromise]);

    // Synthesize report
    const synthesis = await this._orchestrator.synthesizeReport({ run_id });
    const sections = synthesis.sections ?? [];
    const markdown = sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n');

    return {
      generatedAt: new Date().toISOString(),
      detail: request.detail,
      summary: synthesis.summary ?? 'Report generated via orchestrator pipeline.',
      marketCommentary: sections.find(s => s.title.toLowerCase().includes('market'))?.content ?? '',
      markdown,
      items: [],
      risks: [],
      sources: candidates.flatMap(c => c.sources),
      tickers: request.tickers
    } as PredictorResponse;
  }

  private _generateFromCollectorData(
    request: PredictorRequest,
    candidates: Array<{ entity: string; status: string; emergence_score: number; velocity_score: number; source_count: number; sources: string[] }>
  ): PredictorResponse {
    const now = new Date().toISOString();
    const date = request.asOfDate || now.slice(0, 10);

    // Build markdown report from collector data
    const lines: string[] = [];
    lines.push(`# 욕망 레이더 일일 리포트 — ${date}\n`);
    lines.push(`> ${candidates.length}개 신호 후보 기반 (오케스트레이터 미연결, 수집 데이터 직접 분석)\n`);

    // Group by status
    const emerging = candidates.filter(c => c.status === 'emerging' || c.emergence_score >= 7);
    const preheat = candidates.filter(c => c.status === 'preheat' && c.emergence_score < 7);

    if (emerging.length > 0) {
      lines.push(`## 🔥 주요 급부상 신호 (${emerging.length}개)\n`);
      for (const c of emerging.slice(0, 10)) {
        const score = Math.round(c.emergence_score * 100);
        const velocity = Math.round(c.velocity_score * 100);
        lines.push(`- **${c.entity}** — 출현 ${score}% | 확산 속도 ${velocity}% | 소스(${c.source_count}): ${c.sources.join(', ')}`);
      }
      lines.push('');
    }

    if (preheat.length > 0) {
      lines.push(`## 📡 관찰 중인 신호 (${preheat.length}개)\n`);
      for (const c of preheat.slice(0, 10)) {
        const score = Math.round(c.emergence_score * 100);
        lines.push(`- **${c.entity}** — 출현 ${score}% | 소스(${c.source_count}): ${c.sources.join(', ')}`);
      }
      lines.push('');
    }

    const allSources = [...new Set(candidates.flatMap(c => c.sources))];
    lines.push(`## 📊 데이터 소스\n`);
    lines.push(`활성 소스: ${allSources.join(', ')}\n`);

    const markdown = lines.join('\n');
    const summary = `${date} 기준 ${candidates.length}개 신호 후보 탐지. 급부상 ${emerging.length}개, 관찰 중 ${preheat.length}개.`;

    return {
      generatedAt: now,
      detail: request.detail,
      summary,
      marketCommentary: '',
      markdown,
      items: [],
      risks: [],
      sources: allSources,
      tickers: request.tickers
    } as PredictorResponse;
  }

  async getAgentSignals(): Promise<AgentSignal[]> {
    try {
      const health = await this._orchestrator.health();
      const now = new Date().toISOString();

      return health.providers.map(p => ({
        agent: p.provider,
        signal: (p.available ? 'neutral' : 'caution') as SignalValue,
        horizon: '1d' as const,
        confidence: p.available ? 1.0 : 0.0,
        summary: p.available
          ? `Provider ${p.provider} is available`
          : `Provider ${p.provider} is unavailable${p.error ? `: ${p.error}` : ''}`,
        key_factors: [
          `available: ${p.available}`,
          `last_checked: ${p.last_checked_at}`
        ],
        updated_at: p.last_checked_at ?? now
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{
        agent: 'orchestrator-health',
        signal: 'bearish',
        horizon: '1d',
        confidence: 0,
        summary: `Failed to reach orchestrator: ${message}`,
        key_factors: [],
        updated_at: new Date().toISOString()
      }];
    }
  }

  async runAgents(agents?: string[]): Promise<AgentSignal[]> {
    try {
      // 1) Get evidence from collector
      const { candidates } = await this._collector.getEmergingCandidates();

      const entityList = candidates.map(c => c.entity);
      const totalSourceCount = candidates.reduce((sum, c) => sum + c.source_count, 0);

      const bundle: EvidenceBundle = {
        bundle_id: `run-agents-${Date.now()}`,
        entity: entityList.join(', '),
        time_window: {
          start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          end: new Date().toISOString()
        },
        evidence_items: [],
        cross_source_summary: `${candidates.length} candidates, ${totalSourceCount} total source hits`,
        recommended_agents: agents ?? [],
        quality_flags: []
      };

      // 2) Submit evidence
      const { run_id } = await this._orchestrator.submitEvidence({
        topic: 'Agent run',
        evidence_bundle: bundle
      });

      // 3) Run debate with optional agent plan
      const debate = await this._orchestrator.runDebate({
        run_id,
        max_rounds: 3,
        ...(agents?.length ? { plan: agents } : {})
      });

      // 4) Map turns to AgentSignal format
      return debate.turns.map(turnToSignal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{
        agent: 'orchestrator-run',
        signal: 'bearish',
        horizon: '1d',
        confidence: 0,
        summary: `Agent run failed: ${message}`,
        key_factors: [],
        updated_at: new Date().toISOString()
      }];
    }
  }

  async listKnowledge(): Promise<KnowledgeEntry[]> {
    return [];
  }

  async addKnowledge(content: string, tags: string[] = []): Promise<KnowledgeEntry> {
    return {
      id: `stub-${Date.now()}`,
      content,
      tags,
      created_at: new Date().toISOString()
    };
  }

  async removeKnowledge(_id: string): Promise<void> {
    // No-op — orchestrator has no knowledge store equivalent
  }
}

/**
 * Factory that builds the appropriate AnalysisGateway based on the
 * configured backend.
 */
export function createAnalysisGateway(
  backend: AnalysisBackend,
  predictor: PredictorClient,
  orchestrator: OrchestratorClient,
  collector: CollectorClient
): AnalysisGateway {
  if (backend === 'orchestrator') {
    console.log('ANALYSIS_BACKEND=orchestrator — using OrchestratorGatewayAdapter');
    return new OrchestratorGatewayAdapter(orchestrator, collector);
  }
  return predictor;
}
