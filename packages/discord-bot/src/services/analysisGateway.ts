import type {
  AgentSignal,
  KnowledgeEntry,
  PredictorRequest,
  PredictorResponse
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
 * Adapter that wraps OrchestratorClient + CollectorClient to conform
 * to the AnalysisGateway interface.  Currently a stub — the orchestrator
 * pipeline is not yet fully wired.
 */
export class OrchestratorGatewayAdapter implements AnalysisGateway {
  constructor(
    private readonly _orchestrator: OrchestratorClient,
    private readonly _collector: CollectorClient
  ) {}

  async generateReport(_request: PredictorRequest): Promise<PredictorResponse> {
    // Future: 1) get evidence from collector  2) submit to orchestrator
    //         3) run debate  4) synthesize  5) map back to PredictorResponse
    throw new Error('orchestrator analysis backend is not yet implemented');
  }

  async getAgentSignals(): Promise<AgentSignal[]> {
    throw new Error('orchestrator analysis backend is not yet implemented');
  }

  async runAgents(_agents?: string[]): Promise<AgentSignal[]> {
    throw new Error('orchestrator analysis backend is not yet implemented');
  }

  async listKnowledge(): Promise<KnowledgeEntry[]> {
    throw new Error('orchestrator analysis backend is not yet implemented');
  }

  async addKnowledge(_content: string, _tags?: string[]): Promise<KnowledgeEntry> {
    throw new Error('orchestrator analysis backend is not yet implemented');
  }

  async removeKnowledge(_id: string): Promise<void> {
    throw new Error('orchestrator analysis backend is not yet implemented');
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
    console.log('ANALYSIS_BACKEND=orchestrator — using OrchestratorGatewayAdapter (stub)');
    return new OrchestratorGatewayAdapter(orchestrator, collector);
  }
  return predictor;
}
