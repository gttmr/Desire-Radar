import type {
  InvestmentDecisionRequest,
  ModelProfile,
} from '@agentic/shared-types';
import type { PromptLoader } from '../prompt/loader.js';

const RUNTIME_INSTRUCTIONS = `You are executing the investment_decision phase.

Rules:
1. Respond ONLY with valid JSON.
2. Do not invent tickers, companies, or evidence ids.
3. If coverage is incomplete, keep the gap in coverage_gaps instead of guessing.
4. Treat watchlist names as the default scope and be conservative with non-watchlist additions.
5. The downstream report formatter is deterministic. Your output must already be final structured content.
6. Do not inspect the workspace, run tools, or search for extra context. Use only the provided request.
7. Do not ask follow-up questions. Produce the best final decision you can from the provided request now.
`;

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

export class InvestmentDecisionPromptBuilder {
  constructor(private readonly promptLoader: PromptLoader) {}

  async build(args: {
    request: InvestmentDecisionRequest;
    requestMarkdown: string;
    provider: string;
    model?: string;
    modelProfile: ModelProfile;
  }): Promise<string> {
    const agentPrompt = await this.promptLoader.loadAgent('investment_decision');
    const providerOverride = await this.promptLoader.loadProviderOverride(
      'investment_decision',
      args.provider,
    );

    return [
      RUNTIME_INSTRUCTIONS,
      [
        '## Execution Context',
        '- phase: investment_decision',
        `- provider: ${args.provider}`,
        `- model_profile: ${args.modelProfile}`,
        `- model: ${args.model ?? '(provider default)'}`,
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
}
