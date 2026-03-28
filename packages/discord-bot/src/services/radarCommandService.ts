import type { CollectRunResponse, SignalCandidate, SourceStatus, SourcesStatusResponse } from '@agentic/shared-types';
import type { CollectorClient } from './collectorClient.js';

function candidateSources(candidate: Pick<SignalCandidate, 'sources' | 'primary_sources'>): string[] {
  return candidate.sources.length > 0 ? candidate.sources : (candidate.primary_sources ?? []);
}

function candidateLabel(candidate: SignalCandidate): string {
  return candidate.display_label || candidate.primary_entity || candidate.entity;
}

function compact(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(' | ');
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
      const linesForSource = [
        compact([
          `**${name}**`,
          `T${tier}`,
          enabled,
          `state=${state}`,
          source.scheduled ? 'scheduled=yes' : '',
          `last=${last}`,
        ]),
        compact([
          source.current_stage ? `stage=${source.current_stage}` : '',
          source.current_stage_message || '',
        ]),
        compact([
          typeof source.payload_total === 'number' && source.payload_total > 0
            ? `payloads=${source.payloads_processed ?? 0}/${source.payload_total}`
            : '',
          typeof source.evidence_total === 'number' && source.evidence_total > 0
            ? `evidence=${source.evidence_total}`
            : '',
          typeof source.resolve_miss_total === 'number' && source.resolve_miss_total > 0
            ? `resolve_miss=${source.resolve_miss_total}`
            : '',
          typeof source.partial_failure_count === 'number' && source.partial_failure_count > 0
            ? `partial_failures=${source.partial_failure_count}`
            : '',
        ]),
        compact([
          source.source_agent_status ? `agent=${source.source_agent_status}` : '',
          source.source_agent_error || source.last_agent_error || '',
        ]),
        compact([
          source.last_warning_kind ? `warning=${source.last_warning_kind}` : '',
          source.last_failure_kind ? `failure=${source.last_failure_kind}` : '',
          source.last_warning_targets?.length ? `targets=${source.last_warning_targets.join(', ')}` : '',
        ]),
      ].filter(Boolean);
      return linesForSource.join('\n  ');
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
      const label = candidateLabel(candidate);
      const headline = compact([
        `${index + 1}. **${label}**`,
        `[${candidate.status}]`,
        candidate.candidate_kind ? `kind=${candidate.candidate_kind}` : '',
        candidate.cluster_id ? `cluster=${candidate.cluster_id}` : '',
      ]);
      const metrics = compact([
        `출현=${emergence}%`,
        `속도=${velocity}%`,
        `source(${candidate.source_count})=${candidateSources(candidate).join(', ')}`,
      ]);
      const facets = compact([
        candidate.primary_entity && candidate.primary_entity !== label
          ? `primary=${candidate.primary_entity}`
          : '',
        candidate.theme_tags?.length ? `themes=${candidate.theme_tags.join(', ')}` : '',
        candidate.supporting_terms?.length ? `terms=${candidate.supporting_terms.slice(0, 4).join(', ')}` : '',
      ]);
      const summary = candidate.event_summary || candidate.graph_summary || candidate.analysis_summary || '';
      return [headline, `  ${metrics}`, facets ? `  ${facets}` : '', summary ? `  ${summary}` : '']
        .filter(Boolean)
        .join('\n');
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
