import type { EvidenceBundle } from '@agentic/shared-types';
import type { DebatePolicy } from '../config/index.js';
import type { CollectorCandidate } from '../collector/client.js';
import type { TriageDecision } from './types.js';

export class TriageService {
  constructor(private readonly policy: DebatePolicy) {}

  evaluate(candidate: CollectorCandidate, bundle?: EvidenceBundle): TriageDecision {
    if (candidate.emergence_score < this.policy.triage.minimumEmergenceScore) {
      return {
        approved: false,
        reason: `Emergence score ${candidate.emergence_score} is below threshold ${this.policy.triage.minimumEmergenceScore}.`,
        candidate,
        bundle,
      };
    }

    if (candidate.source_count < this.policy.triage.minimumSourceCount) {
      return {
        approved: false,
        reason: `Source count ${candidate.source_count} is below threshold ${this.policy.triage.minimumSourceCount}.`,
        candidate,
        bundle,
      };
    }

    if (!bundle || bundle.evidence_items.length === 0) {
      return {
        approved: false,
        reason: 'No evidence bundle available for candidate.',
        candidate,
        bundle,
      };
    }

    return {
      approved: true,
      reason: `Candidate ${candidate.entity} passed triage with ${candidate.source_count} sources and ${bundle.evidence_items.length} evidence items.`,
      candidate,
      bundle,
    };
  }
}
