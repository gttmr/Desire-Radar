import type { CollectRunResponse, SignalCandidate, SourceStatus, SourcesStatusResponse } from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';

function candidateSources(candidate: Pick<SignalCandidate, 'sources' | 'primary_sources'>): string[] {
  return candidate.sources.length > 0 ? candidate.sources : (candidate.primary_sources ?? []);
}

export class RadarCommandService {
  constructor(private readonly collector: CollectorClient) {}

  async sources(): Promise<string> {
    const status = await this.collector.getSourcesStatus();
    const runtime = status.runtime;
    const sourceEntries = Object.entries(status.sources as Record<string, SourceStatus>);
    if (sourceEntries.length === 0) {
      return '등록된 source가 없습니다.';
    }

    const header = runtime
      ? [
          `source_run_queue=${runtime.source_run_queue_size}`,
          `active_sources=${runtime.active_source_count}`,
          `analysis_queue=${status.analysis.queue_size}`,
        ].join(' | ')
      : `analysis_queue=${status.analysis.queue_size}`;

    const lines = sourceEntries.map(([name, source]) => {
      const tier = source.effective_tier ?? source.configured_tier ?? source.source_tier;
      const state = source.run_state ?? 'unknown';
      const enabled = source.enabled === false ? 'disabled' : 'enabled';
      const last = source.last_run ?? source.last_finished_at ?? 'never';
      const warning = source.last_warning_kind ? ` | warning=${source.last_warning_kind}` : '';
      const failure = source.last_failure_kind ? ` | failure=${source.last_failure_kind}` : '';
      return `**${name}** (T${tier}) | ${enabled} | state=${state} | last=${last}${warning}${failure}`;
    });

    return [header, ...lines].join('\n');
  }

  async candidates(limit = 15): Promise<string> {
    const result = await this.collector.getEmergingCandidates();
    if (result.candidates.length === 0) {
      return '현재 떠오르는 신호 후보가 없습니다.';
    }
    const top = [...result.candidates]
      .sort((a, b) => b.emergence_score - a.emergence_score)
      .slice(0, limit);
    const lines = top.map((candidate, index) => {
      const emergence = Math.round(candidate.emergence_score * 100);
      const velocity = Math.round(candidate.velocity_score * 100);
      return [
        `${index + 1}. **${candidate.entity}** [${candidate.status}]`,
        `출현=${emergence}%`,
        `속도=${velocity}%`,
        `source(${candidate.source_count})=${candidateSources(candidate).join(', ')}`,
      ].join(' | ');
    });
    return `📡 상위 ${top.length}개 / 전체 ${result.count}개\n${lines.join('\n')}`;
  }

  async collect(source?: string): Promise<string> {
    const result = await this.collector.triggerCollect(source);
    return this.formatCollectResult(result, source);
  }

  private formatCollectResult(result: CollectRunResponse, source?: string): string {
    if ('total_evidence_count' in result) {
      const lines = [
        source ? `수집 요청: ${source}` : '수집 요청: enabled pull source 전체',
        `queued_count=${result.queued_count ?? 0}`,
        `total_evidence_count=${result.total_evidence_count}`,
      ];
      if (result.queued_sources && result.queued_sources.length > 0) {
        lines.push(`queued_sources=${result.queued_sources.join(', ')}`);
      }
      if (result.skipped_sources && Object.keys(result.skipped_sources).length > 0) {
        lines.push(
          `skipped=${Object.entries(result.skipped_sources)
            .map(([id, reason]) => `${id}:${reason}`)
            .join(', ')}`,
        );
      }
      if (typeof result.skipped_disabled_count === 'number') {
        lines.push(`skipped_disabled_count=${result.skipped_disabled_count}`);
      }
      return lines.join('\n');
    }

    const lines = [
      `수집 요청: ${result.connector}`,
      `status=${result.status ?? 'completed'}`,
      `evidence_count=${result.evidence_count}`,
    ];
    if (result.submission_id) {
      lines.push(`submission_id=${result.submission_id}`);
    }
    if (result.queued_sources && result.queued_sources.length > 0) {
      lines.push(`queued_sources=${result.queued_sources.join(', ')}`);
    }
    if (result.skipped_sources && Object.keys(result.skipped_sources).length > 0) {
      lines.push(
        `skipped=${Object.entries(result.skipped_sources)
          .map(([id, reason]) => `${id}:${reason}`)
          .join(', ')}`,
      );
    }
    if (typeof result.skipped_disabled_count === 'number') {
      lines.push(`skipped_disabled_count=${result.skipped_disabled_count}`);
    }
    return lines.join('\n');
  }
}
