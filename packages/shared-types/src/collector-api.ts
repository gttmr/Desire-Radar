// ---------------------------------------------------------------
// Collector REST API request/response types
// ---------------------------------------------------------------

import type { EvidenceBundle, SignalCandidate, SourceStatus, ManualObservation } from './evidence.js';

// POST /collect/run
export type CollectRunRequest = {
  sources?: string[]; // specific sources to run, or all if omitted
  force?: boolean;    // ignore cadence cooldown
};
export type CollectRunResponse = {
  ok: boolean;
  sources_executed: string[];
  evidence_count: number;
  candidates_created: number;
};

// GET /candidates/emerging
export type EmergingCandidatesResponse = {
  candidates: SignalCandidate[];
  count: number;
};

// GET /evidence/bundles/:entity
export type EvidenceBundleResponse = {
  bundle: EvidenceBundle | null;
  entity: string;
};

// GET /sources/status
export type SourcesStatusResponse = {
  sources: SourceStatus[];
};

// POST /review/approve
export type ReviewApproveRequest = {
  evidence_id: string;
  reviewer?: string;
};
export type ReviewApproveResponse = {
  ok: boolean;
  evidence_id: string;
};

// POST /review/reject
export type ReviewRejectRequest = {
  evidence_id: string;
  reason?: string;
  reviewer?: string;
};
export type ReviewRejectResponse = {
  ok: boolean;
  evidence_id: string;
};

// POST /manual-observation (human input connector)
export type ManualObservationRequest = ManualObservation;
export type ManualObservationResponse = {
  ok: boolean;
  evidence_id: string;
  entity_candidates: string[];
};

// --- Internal APIs (MCP orchestrator consumption) ---

// GET /internal/next-candidates
export type NextCandidatesResponse = {
  candidates: SignalCandidate[];
};

// POST /internal/build-bundle
export type BuildBundleRequest = {
  entity: string;
  time_window?: { start: string; end: string };
};
export type BuildBundleResponse = {
  bundle: EvidenceBundle;
};

// GET /internal/entity-history/:entity
export type EntityHistoryResponse = {
  entity: string;
  history: Array<{
    date: string;
    evidence_count: number;
    emergence_score: number;
    sources: string[];
  }>;
};
