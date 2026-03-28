import { describe, expect, it } from 'vitest';
import type { CollectRunResponse, EmergingCandidatesResponse, SourcesStatusResponse } from '@agentic/shared-types';
import { RadarCommandService } from '../src/services/radarCommandService.js';

class FakeCollectorClient {
  constructor(
    private readonly sources: SourcesStatusResponse,
    private readonly candidates: EmergingCandidatesResponse,
    private readonly collectResult: CollectRunResponse,
  ) {}

  async getSourcesStatus(): Promise<SourcesStatusResponse> {
    return this.sources;
  }

  async getEmergingCandidates(): Promise<EmergingCandidatesResponse> {
    return this.candidates;
  }

  async triggerCollect(): Promise<CollectRunResponse> {
    return this.collectResult;
  }
}

describe('RadarCommandService', () => {
  it('summarizes source status with runtime queue information', async () => {
    const service = new RadarCommandService(
      new FakeCollectorClient(
        {
          analysis: { enabled: true, queue_size: 2 },
          runtime: {
            source_run_queue_size: 1,
            source_run_worker_concurrency: 2,
            active_source_count: 1,
          },
          sources: {
            reddit_mentions: {
              cadence_seconds: 300,
              source_tier: 2,
              last_run: '2026-03-28T00:00:00Z',
              scheduled: true,
              enabled: true,
              run_state: 'running',
              current_stage: 'processing_payloads',
              current_stage_message: 'processing 10/20',
              payload_total: 20,
              payloads_processed: 10,
              evidence_total: 8,
              source_agent_status: 'running',
              last_warning_kind: 'http_403_blocked',
            },
          },
        },
        { candidates: [], count: 0 },
        { total_evidence_count: 0, queued_count: 1, queued_sources: ['reddit_mentions'], per_connector: {} },
      ) as never,
    );

    const content = await service.sources();
    expect(content).toContain('source_run_queue=1');
    expect(content).toContain('**reddit_mentions**');
    expect(content).toContain('stage=processing_payloads');
    expect(content).toContain('agent=running');
    expect(content).toContain('warning=http_403_blocked');
  });

  it('shows top candidates and collect queue metadata', async () => {
    const service = new RadarCommandService(
      new FakeCollectorClient(
        {
          analysis: { enabled: true, queue_size: 0 },
          sources: {},
        },
        {
          count: 2,
          candidates: [
            {
              entity: 'Cursor',
              display_label: 'Cursor IDE',
              candidate_kind: 'entity_cluster',
              cluster_id: 'cluster-cursor',
              primary_entity: 'Cursor',
              theme_tags: ['developer-tools'],
              supporting_terms: ['cursor', 'seat expansion'],
              event_summary: 'Seat expansion chatter is accelerating',
              status: 'emerging',
              emergence_score: 0.9,
              velocity_score: 0.7,
              source_count: 2,
              evidence_ids: ['ev-1'],
              sources: ['reddit_mentions'],
              primary_sources: [],
              first_seen: '2026-03-28T00:00:00Z',
              last_seen: '2026-03-28T00:00:00Z',
            },
            {
              entity: 'AV1',
              status: 'preheat',
              emergence_score: 0.4,
              velocity_score: 0.2,
              source_count: 1,
              evidence_ids: ['ev-2'],
              sources: ['reddit_mentions'],
              primary_sources: [],
              first_seen: '2026-03-28T00:00:00Z',
              last_seen: '2026-03-28T00:00:00Z',
            },
          ],
        },
        {
          total_evidence_count: 0,
          queued_count: 2,
          queued_sources: ['reddit_mentions', 'app_store_top_charts'],
          skipped_sources: { google_trends: 'source_disabled' },
          skipped_disabled_count: 1,
          per_connector: {},
        },
      ) as never,
    );

    const candidates = await service.candidates(1);
    expect(candidates).toContain('**Cursor IDE**');
    expect(candidates).toContain('kind=entity_cluster');
    expect(candidates).toContain('cluster=cluster-cursor');
    expect(candidates).toContain('themes=developer-tools');
    const collect = await service.collect();
    expect(collect).toContain('queued_sources=reddit_mentions, app_store_top_charts');
    expect(collect).toContain('google_trends:source_disabled');
  });
});
