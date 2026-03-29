import type {
  InvestmentDecisionArtifact,
  InvestmentDecisionRecommendationItem,
  InvestmentDecisionRequest,
} from '@agentic/shared-types';
import type { ReportDetailLevel } from '@agentic/shared-types';

function formatItemBrief(item: InvestmentDecisionRecommendationItem): string {
  return `- ${item.company_name} (\`${item.ticker}\`) · ${item.recommendation} · ${(item.confidence * 100).toFixed(0)}% · ${item.why_now}`;
}

function formatItemFull(item: InvestmentDecisionRecommendationItem): string[] {
  return [
    `### ${item.company_name} (\`${item.ticker}\`)`,
    '',
    `- recommendation: ${item.recommendation}`,
    `- confidence: ${(item.confidence * 100).toFixed(0)}%`,
    `- why_now: ${item.why_now}`,
    `- beneficiary_path: ${item.beneficiary_path}`,
    `- linked_clusters: ${item.linked_clusters.join(', ') || '(none)'}`,
    `- linked_evidence_refs: ${item.linked_evidence_refs.join(', ') || '(none)'}`,
    '',
    '#### Thesis',
    '',
    item.thesis || '(none)',
    '',
    '#### Risks',
    '',
    ...(item.risks.length > 0 ? item.risks.map((risk) => `- ${risk}`) : ['- (none)']),
    '',
    '#### Missing Information',
    '',
    ...(item.missing_information.length > 0
      ? item.missing_information.map((entry) => `- ${entry}`)
      : ['- (none)']),
    '',
  ];
}

function formatCoverageGaps(
  artifact: InvestmentDecisionArtifact,
): string[] {
  if (artifact.coverage_gaps.length === 0) {
    return ['- (none)'];
  }
  return artifact.coverage_gaps.map(
    (gap) =>
      `- ${gap.label}: ${gap.reason}${gap.linked_cluster_id ? ` [cluster=${gap.linked_cluster_id}]` : ''}`,
  );
}

function formatSourceHealth(request: InvestmentDecisionRequest): string[] {
  if (request.source_health_summary.length === 0) {
    return ['- (none)'];
  }
  return request.source_health_summary.map(
    (source) =>
      `- ${source.source_id}: readiness=${source.readiness_status ?? 'unknown'}${
        source.quality_status ? `, quality=${source.quality_status}` : ''
      }${source.freshness_lag_seconds != null ? `, freshness_lag=${source.freshness_lag_seconds}s` : ''}`,
  );
}

export class InvestmentReportFormatter {
  formatReport(
    request: InvestmentDecisionRequest,
    artifact: InvestmentDecisionArtifact,
    detail: ReportDetailLevel,
  ): string {
    const title = `# Daily Investment Shortlist — ${request.window.label}`;
    const sections: string[] = [
      title,
      '',
      `> run_id=${request.run_id} · mode=${request.mode} · generated_at=${artifact.generated_at}`,
      '',
      '## Summary',
      '',
      artifact.summary || '(none)',
      '',
      '## Market View',
      '',
      artifact.market_view || '(none)',
      '',
    ];

    if (detail === 'summary') {
      sections.push(
        '## Top Picks',
        '',
        ...(artifact.top_picks.length > 0
          ? artifact.top_picks.map(formatItemBrief)
          : ['- (none)']),
        '',
        '## Watch Candidates',
        '',
        ...(artifact.watch_candidates.length > 0
          ? artifact.watch_candidates.map(formatItemBrief)
          : ['- (none)']),
        '',
        '## Rejected Candidates',
        '',
        ...(artifact.rejected_candidates.length > 0
          ? artifact.rejected_candidates.map(formatItemBrief)
          : ['- (none)']),
      );
    } else {
      sections.push(
        '## Request Scope',
        '',
        `- watchlist: ${request.watchlist.join(', ') || '(none)'}`,
        `- resolved_equities: ${request.resolved_equities.length}`,
        `- candidate_clusters: ${request.candidate_clusters.length}`,
        '',
        '## Top Picks',
        '',
        ...(artifact.top_picks.length > 0
          ? artifact.top_picks.flatMap(formatItemFull)
          : ['- (none)', '']),
        '## Watch Candidates',
        '',
        ...(artifact.watch_candidates.length > 0
          ? artifact.watch_candidates.flatMap(formatItemFull)
          : ['- (none)', '']),
        '## Rejected Candidates',
        '',
        ...(artifact.rejected_candidates.length > 0
          ? artifact.rejected_candidates.flatMap(formatItemFull)
          : ['- (none)', '']),
      );
    }

    sections.push(
      '',
      '## Coverage Gaps',
      '',
      ...formatCoverageGaps(artifact),
      '',
      '## Risks',
      '',
      ...(artifact.risks.length > 0 ? artifact.risks.map((risk) => `- ${risk}`) : ['- (none)']),
      '',
      '## Source Health',
      '',
      ...formatSourceHealth(request),
    );

    if (artifact.degraded) {
      sections.push('', '## Degraded Execution', '', artifact.degraded_reason ?? '(none)');
    }

    return sections.join('\n');
  }

  renderRequestMarkdown(request: InvestmentDecisionRequest): string {
    return [
      `# Investment Decision Request — ${request.window.label}`,
      '',
      `- run_id: ${request.run_id}`,
      `- mode: ${request.mode}`,
      `- watchlist: ${request.watchlist.join(', ') || '(none)'}`,
      `- supporting_evidence_ref_count: ${request.supporting_evidence_refs.length}`,
      `- coverage_gap_count: ${request.coverage_gaps.length}`,
      '',
      '## Resolved Equities',
      '',
      ...(request.resolved_equities.length > 0
        ? request.resolved_equities.map(
            (item) =>
              `- ${item.company_name} (\`${item.ticker}\`) · watchlist=${item.watchlist_member} · scope=${item.why_in_scope}`,
          )
        : ['- (none)']),
      '',
      '## Candidate Clusters',
      '',
      ...(request.candidate_clusters.length > 0
        ? request.candidate_clusters.map(
            (cluster) =>
              `- ${cluster.display_label} · sources=${cluster.supporting_sources.join(', ') || '(none)'} · event=${cluster.event_summary ?? '(none)'}`,
          )
        : ['- (none)']),
      '',
      '## Investment Notes',
      '',
      ...(request.investment_notes.length > 0
        ? request.investment_notes.map(
            (note) => `- ${note.title} [${note.asset_key ?? 'unresolved'}] · ${note.summary}`,
          )
        : ['- (none)']),
      '',
      '## Source Health',
      '',
      ...formatSourceHealth(request),
      '',
      '## Coverage Gaps',
      '',
      ...request.coverage_gaps.map((gap) => `- ${gap.label}: ${gap.reason}`),
    ].join('\n');
  }

  renderResponseMarkdown(
    request: InvestmentDecisionRequest,
    artifact: InvestmentDecisionArtifact,
  ): string {
    return this.formatReport(request, artifact, 'full');
  }
}
