import type {
  InvestmentDecisionRequest,
  InvestmentCoverageGap,
  ModelProfile,
} from '@agentic/shared-types';
import type { PromptLoader } from '../prompt/loader.js';
import type { ToolPolicy } from '../providers/base.js';

function buildPreparationRuntimeInstructions(toolPolicy: ToolPolicy): string {
  const toolRule =
    toolPolicy === 'none'
      ? '4. Do not inspect the workspace, run tools, browse, or search for extra context.'
      : '4. Prefer not to use tools. Only use them if they are strictly necessary, and never use them to replace simple restructuring of the provided request.';
  return `You are executing the investment_decision preparation step.

Rules:
1. Respond ONLY with valid JSON.
2. Preserve important facts, names, tickers, coverage gaps, and source health warnings from the provided request.
3. Do not invent companies, tickers, evidence ids, or new facts.
${toolRule}
5. This step is only for restructuring and compressing the provided request into a cleaner briefing for a downstream final decision model.
6. If coverage is incomplete, keep the gap in coverage_gaps instead of pretending it is resolved.
7. Keep the output concise and loss-aware. Summarize without dropping material investment signals.
`;
}

function buildDecisionRuntimeInstructions(toolPolicy: ToolPolicy): string {
  const toolRule =
    toolPolicy === 'none'
      ? '6. Do not inspect the workspace, run tools, or search for extra context. Use only the provided request and prepared briefing.'
      : '6. Prefer to use only the provided request and prepared briefing. Tool use is optional, and should be reserved for cases where the supplied artifacts are genuinely insufficient.';
  return `You are executing the investment_decision final decision step.

Rules:
1. Respond ONLY with valid JSON.
2. Do not invent tickers, companies, or evidence ids.
3. If coverage is incomplete, keep the gap in coverage_gaps instead of guessing.
4. Treat watchlist names as the default scope and be conservative with non-watchlist additions.
5. The downstream report formatter is deterministic. Your output must already be final structured content.
${toolRule}
7. Do not ask follow-up questions. Produce the best final decision you can from the provided request now.
`;
}

export type PreparedInvestmentDecisionBriefing = {
  executive_summary: string;
  market_context: string;
  watchlist_focus: string[];
  resolved_equity_briefs: Array<{
    asset_key: string;
    ticker: string;
    company_name: string;
    priority: 'high' | 'medium' | 'low';
    why_in_scope: string;
    key_signals: string[];
    key_risks: string[];
    linked_clusters: string[];
    linked_notes: string[];
    watchlist_member: boolean;
  }>;
  cluster_briefs: Array<{
    cluster_id: string | null;
    display_label: string;
    candidate_kind: 'entity_cluster';
    why_it_matters: string;
    supporting_sources: string[];
    theme_tags: string[];
    event_summary: string;
    graph_summary: string;
    linked_equities: string[];
    evidence_count: number;
  }>;
  note_briefs: Array<{
    intake_id: string;
    asset_key: string | null;
    title: string;
    summary: string;
    why_it_might_matter: string;
  }>;
  source_health_flags: string[];
  coverage_gaps: InvestmentCoverageGap[];
};

function buildCompactRequestProjection(request: InvestmentDecisionRequest) {
  return {
    run_id: request.run_id,
    created_at: request.created_at,
    mode: request.mode,
    window: request.window,
    watchlist: request.watchlist,
    resolved_equities: request.resolved_equities.map((item) => ({
      asset_key: item.asset_key,
      ticker: item.ticker,
      company_name: item.company_name,
      why_in_scope: item.why_in_scope,
      linked_clusters: item.linked_clusters.slice(0, 4),
      linked_notes: item.linked_notes.slice(0, 4),
      watchlist_member: item.watchlist_member,
    })),
    candidate_clusters: request.candidate_clusters.map((cluster) => ({
      cluster_id: cluster.cluster_id,
      display_label: cluster.display_label,
      primary_entity: cluster.primary_entity,
      supporting_sources: cluster.supporting_sources,
      supporting_terms: cluster.supporting_terms.slice(0, 6),
      theme_tags: cluster.theme_tags,
      event_summary: cluster.event_summary,
      graph_summary: cluster.graph_summary,
      evidence_ids_sample: cluster.evidence_ids.slice(0, 5),
      evidence_count: cluster.evidence_ids.length,
      emergence_score: cluster.emergence_score,
      velocity_score: cluster.velocity_score,
      status: cluster.status,
    })),
    investment_notes: request.investment_notes.map((note) => ({
      intake_id: note.intake_id,
      asset_key: note.asset_key ?? null,
      title: note.title,
      summary: note.summary,
      why_it_might_matter: note.why_it_might_matter,
      open_questions: note.open_questions.slice(0, 5),
      source_submission_id: note.source_submission_id,
      created_at: note.created_at,
    })),
    source_health_summary: request.source_health_summary,
    coverage_gaps: request.coverage_gaps,
    supporting_evidence_ref_count: request.supporting_evidence_refs.length,
    schema_version: request.schema_version,
  };
}

function rankPriority(index: number): 'high' | 'medium' | 'low' {
  if (index < 3) {
    return 'high';
  }
  if (index < 7) {
    return 'medium';
  }
  return 'low';
}

function buildSourceHealthFlags(request: InvestmentDecisionRequest): string[] {
  return request.source_health_summary
    .map((item) => {
      const parts = [
        item.source_id,
        item.readiness_status ? `readiness=${item.readiness_status}` : null,
        item.quality_status ? `quality=${item.quality_status}` : null,
        item.readiness_reason ? `reason=${item.readiness_reason}` : null,
        item.last_failure_kind ? `failure=${item.last_failure_kind}` : null,
      ].filter((part): part is string => Boolean(part));
      return parts.join(' | ');
    })
    .filter(Boolean);
}

export function buildDeterministicPreparedBriefing(
  request: InvestmentDecisionRequest,
): PreparedInvestmentDecisionBriefing {
  const equityByCluster = new Map<string, string[]>();
  for (const equity of request.resolved_equities) {
    for (const clusterId of equity.linked_clusters) {
      const current = equityByCluster.get(clusterId) ?? [];
      current.push(equity.ticker);
      equityByCluster.set(clusterId, [...new Set(current)]);
    }
  }

  return {
    executive_summary:
      request.candidate_clusters.length > 0
        ? `Prepared fallback briefing for ${request.resolved_equities.length} equities and ${request.candidate_clusters.length} candidate clusters.`
        : `Prepared fallback briefing for ${request.resolved_equities.length} equities with limited candidate cluster support.`,
    market_context:
      buildSourceHealthFlags(request).join(' || ') ||
      'No source health degradations were included in the request.',
    watchlist_focus: request.watchlist.slice(0, 20),
    resolved_equity_briefs: request.resolved_equities.map((equity, index) => ({
      asset_key: equity.asset_key,
      ticker: equity.ticker,
      company_name: equity.company_name,
      priority: rankPriority(index),
      why_in_scope: equity.why_in_scope,
      key_signals: [],
      key_risks: [],
      linked_clusters: equity.linked_clusters.slice(0, 8),
      linked_notes: equity.linked_notes.slice(0, 8),
      watchlist_member: equity.watchlist_member,
    })),
    cluster_briefs: request.candidate_clusters.slice(0, 20).map((cluster) => ({
      cluster_id: cluster.cluster_id ?? null,
      display_label: cluster.display_label,
      candidate_kind: 'entity_cluster' as const,
      why_it_matters:
        cluster.event_summary?.trim() ||
        cluster.graph_summary?.trim() ||
        `Signal cluster '${cluster.display_label}' requires investment review.`,
      supporting_sources: cluster.supporting_sources.slice(0, 6),
      theme_tags: cluster.theme_tags.slice(0, 6),
      event_summary: cluster.event_summary?.trim() ?? '',
      graph_summary: cluster.graph_summary?.trim() ?? '',
      linked_equities: cluster.cluster_id
        ? equityByCluster.get(cluster.cluster_id) ?? []
        : [],
      evidence_count: cluster.evidence_ids.length,
    })),
    note_briefs: request.investment_notes.slice(0, 12).map((note) => ({
      intake_id: note.intake_id,
      asset_key: note.asset_key ?? null,
      title: note.title,
      summary: note.summary,
      why_it_might_matter: note.why_it_might_matter,
    })),
    source_health_flags: buildSourceHealthFlags(request),
    coverage_gaps: request.coverage_gaps,
  };
}

function renderPreparedBriefingMarkdown(
  briefing: PreparedInvestmentDecisionBriefing,
): string {
  const equityLines =
    briefing.resolved_equity_briefs.length > 0
      ? briefing.resolved_equity_briefs
          .map(
            (item) =>
              `- ${item.ticker} (${item.company_name}) [${item.priority}] :: ${item.why_in_scope}`,
          )
          .join('\n')
      : '- none';
  const clusterLines =
    briefing.cluster_briefs.length > 0
      ? briefing.cluster_briefs
          .map(
            (item) =>
              `- ${item.display_label}${item.event_summary ? ` :: ${item.event_summary}` : ''}`,
          )
          .join('\n')
      : '- none';
  const healthLines =
    briefing.source_health_flags.length > 0
      ? briefing.source_health_flags.map((item) => `- ${item}`).join('\n')
      : '- none';
  return [
    `# Prepared Investment Decision Briefing`,
    '',
    `## Executive Summary`,
    briefing.executive_summary || 'No summary provided.',
    '',
    `## Market Context`,
    briefing.market_context || 'No market context provided.',
    '',
    `## Watchlist Focus`,
    briefing.watchlist_focus.join(', ') || 'none',
    '',
    `## Resolved Equities`,
    equityLines,
    '',
    `## Cluster Briefs`,
    clusterLines,
    '',
    `## Source Health Flags`,
    healthLines,
  ].join('\n');
}

export class InvestmentDecisionPromptBuilder {
  constructor(private readonly promptLoader: PromptLoader) {}

  buildPreparedBriefingFallback(
    request: InvestmentDecisionRequest,
  ): PreparedInvestmentDecisionBriefing {
    return buildDeterministicPreparedBriefing(request);
  }

  renderPreparedBriefingMarkdown(
    briefing: PreparedInvestmentDecisionBriefing,
  ): string {
    return renderPreparedBriefingMarkdown(briefing);
  }

  async buildPreparation(args: {
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
    provider: string;
    model?: string;
    modelProfile: ModelProfile;
    toolPolicy: ToolPolicy;
  }): Promise<string> {
    const agentPrompt = await this.promptLoader.loadAgent('investment_decision_prepare');
    const providerOverride = await this.promptLoader.loadProviderOverride(
      'investment_decision_prepare',
      args.provider,
    );

    return [
      buildPreparationRuntimeInstructions(args.toolPolicy),
      [
        '## Execution Context',
        '- phase: investment_decision',
        '- step: prepare',
        `- provider: ${args.provider}`,
        `- model_profile: ${args.modelProfile}`,
        `- model: ${args.model ?? '(provider default)'}`,
        `- tool_policy: ${args.toolPolicy}`,
      ].join('\n'),
      agentPrompt,
      providerOverride ? `## Provider-Specific Instructions\n${providerOverride}` : null,
      '## Decision Request (Markdown)',
      args.requestMarkdown,
      '## Decision Request (Compact JSON)',
      '```json',
      JSON.stringify(buildCompactRequestProjection(args.request), null, 2),
      '```',
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n---\n\n');
  }

  async buildDecision(args: {
    request: InvestmentDecisionRequest;
    preparedBriefing: PreparedInvestmentDecisionBriefing;
    provider: string;
    model?: string;
    modelProfile: ModelProfile;
    toolPolicy: ToolPolicy;
  }): Promise<string> {
    const agentPrompt = await this.promptLoader.loadAgent('investment_decision');
    const providerOverride = await this.promptLoader.loadProviderOverride(
      'investment_decision',
      args.provider,
    );

    const exactScope = {
      watchlist: args.request.watchlist,
      resolved_equities: args.request.resolved_equities.map((item) => ({
        asset_key: item.asset_key,
        ticker: item.ticker,
        company_name: item.company_name,
        why_in_scope: item.why_in_scope,
        linked_clusters: item.linked_clusters,
        linked_notes: item.linked_notes,
        watchlist_member: item.watchlist_member,
      })),
      coverage_gaps: args.request.coverage_gaps,
      source_health_summary: args.request.source_health_summary,
      supporting_evidence_ref_count: args.request.supporting_evidence_refs.length,
      schema_version: args.request.schema_version,
    };

    return [
      buildDecisionRuntimeInstructions(args.toolPolicy),
      [
        '## Execution Context',
        '- phase: investment_decision',
        '- step: final_decision',
        `- provider: ${args.provider}`,
        `- model_profile: ${args.modelProfile}`,
        `- model: ${args.model ?? '(provider default)'}`,
        `- tool_policy: ${args.toolPolicy}`,
      ].join('\n'),
      agentPrompt,
      providerOverride ? `## Provider-Specific Instructions\n${providerOverride}` : null,
      '## Prepared Briefing (Markdown)',
      renderPreparedBriefingMarkdown(args.preparedBriefing),
      '## Prepared Briefing (JSON)',
      '```json',
      JSON.stringify(args.preparedBriefing, null, 2),
      '```',
      '## Exact Investment Scope (Compact JSON)',
      '```json',
      JSON.stringify(exactScope, null, 2),
      '```',
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n---\n\n');
  }

  async build(args: {
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
    provider: string;
    model?: string;
    modelProfile: ModelProfile;
    toolPolicy?: ToolPolicy;
  }): Promise<string> {
    return this.buildDecision({
      request: args.request,
      preparedBriefing: this.buildPreparedBriefingFallback(args.request),
      provider: args.provider,
      model: args.model,
      modelProfile: args.modelProfile,
      toolPolicy: args.toolPolicy ?? 'default',
    });
  }
}
