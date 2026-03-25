import type { AgentTurn, EvidenceBundle, Evidence } from '@agentic/shared-types';
import type { CollectorCandidate, CollectorSourceStatus } from '../collector/client.js';
import type { ResearchResult } from '../collector/research-service.js';
import type { ExecutionPhase } from '../providers/base.js';

export type PromptContextInput = {
  phase: ExecutionPhase;
  evidenceBundle?: EvidenceBundle;
  candidate?: CollectorCandidate;
  otherAgentMessages?: Array<{ from: string; content: string }>;
  orchestratorQuestions?: string[];
  debateTurns?: AgentTurn[];
  researchResults?: ResearchResult[];
  sourceStatus?: Record<string, CollectorSourceStatus>;
  verdictSummary?: string;
};

export function buildPhaseContext(input: PromptContextInput): string[] {
  switch (input.phase) {
    case 'triage':
      return buildTriageContext(input);
    case 'verdict':
      return buildVerdictContext(input);
    case 'report':
      return buildReportContext(input);
    case 'debate':
    default:
      return buildDebateContext(input);
  }
}

function buildTriageContext(input: PromptContextInput): string[] {
  const sections: string[] = [];
  if (input.candidate) {
    sections.push(
      [
        '## Candidate Snapshot',
        `- entity: ${input.candidate.entity}`,
        `- status: ${input.candidate.status}`,
        `- emergence_score: ${input.candidate.emergence_score}`,
        `- velocity_score: ${input.candidate.velocity_score}`,
        `- source_count: ${input.candidate.source_count}`,
        `- sources: ${input.candidate.sources.join(', ') || '(none)'}`,
      ].join('\n'),
    );
  }

  if (input.evidenceBundle) {
    sections.push(`## Evidence Summary\n${summarizeEvidenceBundle(input.evidenceBundle, 4)}`);
  }

  if (input.orchestratorQuestions?.length) {
    sections.push(renderQuestions(input.orchestratorQuestions));
  }

  return sections;
}

function buildDebateContext(input: PromptContextInput): string[] {
  const sections: string[] = [];

  if (input.evidenceBundle) {
    sections.push(`## Evidence Summary\n${summarizeEvidenceBundle(input.evidenceBundle, 8)}`);
  }

  if (input.sourceStatus && input.evidenceBundle) {
    const lines = input.evidenceBundle.evidence_items
      .map((item) => item.source)
      .filter((source, index, items) => items.indexOf(source) === index)
      .map((source) => {
        const status = input.sourceStatus?.[source];
        if (!status) {
          return `- ${source}: status unavailable`;
        }
        const tier = status.effective_tier ?? status.configured_tier ?? status.source_tier;
        const pending = status.pending_submissions ?? 0;
        return `- ${source}: kind=${status.kind ?? 'unknown'}, mode=${status.ingestion_mode ?? 'unknown'}, T${tier}, enabled=${status.enabled ?? true}, runnable=${status.runnable ?? false}, pending=${pending}, last_run=${status.last_run ?? 'never'}${status.validity_status ? `, validity=${status.validity_status}` : ''}`;
      });
    if (lines.length > 0) {
      sections.push(`## Source Status\n${lines.join('\n')}`);
    }
  }

  if (input.otherAgentMessages?.length) {
    const messages = input.otherAgentMessages
      .map((message) => `- ${message.from}: ${message.content}`)
      .join('\n');
    sections.push(`## Messages From Other Agents\n${messages}`);
  }

  if (input.orchestratorQuestions?.length) {
    sections.push(renderQuestions(input.orchestratorQuestions));
  }

  return sections;
}

function buildVerdictContext(input: PromptContextInput): string[] {
  const sections: string[] = [];

  if (input.evidenceBundle) {
    sections.push(`## Evidence Summary\n${summarizeEvidenceBundle(input.evidenceBundle, 6)}`);
  }

  if (input.debateTurns?.length) {
    const claims = input.debateTurns
      .slice(-8)
      .map((turn) => `- ${turn.agent_name} (${turn.provider}): ${turn.response.summary}`)
      .join('\n');
    sections.push(`## Debate Summary\n${claims}`);
  }

  if (input.researchResults?.length) {
    const results = input.researchResults
      .map(
        (result) =>
          `- ${result.request.requestedByAgent} -> ${result.request.requestKind} (${result.status}): ${result.request.question}`,
      )
      .join('\n');
    sections.push(`## Research Results\n${results}`);
  }

  if (input.orchestratorQuestions?.length) {
    sections.push(renderQuestions(input.orchestratorQuestions));
  }

  return sections;
}

function buildReportContext(input: PromptContextInput): string[] {
  const sections: string[] = [];

  if (input.verdictSummary) {
    sections.push(`## Final Verdict\n${input.verdictSummary}`);
  }

  if (input.debateTurns?.length) {
    const highlights = input.debateTurns
      .slice(-6)
      .map((turn) => `- ${turn.agent_name}: ${turn.response.summary}`)
      .join('\n');
    sections.push(`## Supporting Highlights\n${highlights}`);
  }

  if (input.researchResults?.length) {
    const questions = input.researchResults
      .filter((result) => result.status !== 'completed')
      .map((result) => `- ${result.request.question}`)
      .join('\n');
    if (questions) {
      sections.push(`## Remaining Open Questions\n${questions}`);
    }
  }

  return sections;
}

function summarizeEvidenceBundle(bundle: EvidenceBundle, limit: number): string {
  const parts = [
    `- entity: ${bundle.entity}`,
    `- time_window: ${bundle.time_window.start} -> ${bundle.time_window.end}`,
    `- cross_source_summary: ${bundle.cross_source_summary || '(none)'}`,
  ];

  const evidenceLines = bundle.evidence_items
    .slice(0, limit)
    .map((item) => summarizeEvidence(item));

  if (evidenceLines.length > 0) {
    parts.push('### Evidence');
    parts.push(...evidenceLines.map((line) => `- ${line}`));
  }

  if (bundle.evidence_items.length > limit) {
    parts.push(`- additional_evidence_count: ${bundle.evidence_items.length - limit}`);
  }

  return parts.join('\n');
}

function summarizeEvidence(item: Evidence): string {
  const metrics = [
    item.metric_value != null ? `value=${item.metric_value}` : null,
    item.metric_delta != null ? `delta=${item.metric_delta}` : null,
    item.rank != null ? `rank=${item.rank}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return `${item.evidence_id} | ${item.source} | T${item.source_tier} | ${item.title_or_label}${metrics ? ` | ${metrics}` : ''}`;
}

function renderQuestions(questions: string[]): string {
  return `## Orchestrator Questions\n${questions
    .map((question, index) => `${index + 1}. ${question}`)
    .join('\n')}`;
}
