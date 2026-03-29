import type { EvidenceBundle } from '@agentic/shared-types';
import { CollectorClient, type CollectorCandidate, type CollectorSourceStatus } from './client.js';

export class CandidateService {
  constructor(private readonly client: CollectorClient) {}

  getNextCandidates(onlyNeedsAnalysis = false): Promise<CollectorCandidate[]> {
    return this.client.getNextCandidates(onlyNeedsAnalysis);
  }

  getEmergingCandidates(): Promise<CollectorCandidate[]> {
    return this.client.getEmergingCandidates();
  }

  buildBundle(entity: string, maxEvidence?: number): Promise<EvidenceBundle> {
    return this.client.buildBundle(entity, maxEvidence);
  }

  getSourcesStatus(): Promise<Record<string, CollectorSourceStatus>> {
    return this.client.getSourcesStatus();
  }

  getSourcesCatalog(): Promise<Record<string, CollectorSourceStatus>> {
    return this.client.getSourcesCatalog();
  }
}
