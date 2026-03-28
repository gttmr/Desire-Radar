import { describe, expect, it } from 'vitest';
import { RunCommandService } from '../src/services/runCommandService.js';

class FakeOrchestratorClient {
  async runFromCandidate() {
    return {
      run_id: 'run-1',
      triage: { approved: true, reason: 'strong signal' },
      debate: { status: 'consensus', roundsExecuted: 2, turns: [] },
      research: { executed: true, results: [], reranDebate: false },
      verdict: {
        runId: 'run-1',
        entity: 'Cursor',
        summary: 'Workflow demand is investable',
        confidence: 0.82,
        recommendation: 'watch_closely',
        beneficiary_mapping: {
          summary: 'Cursor and infra beneficiaries',
          direct_winners: [{ name: 'Cursor', category: 'direct_winner', rationale: '', supporting_evidence: [], confidence: 0.8 }],
          public_beneficiaries: [{ name: 'MSFT', category: 'public_beneficiary', rationale: '', supporting_evidence: [], confidence: 0.7 }],
          second_order_beneficiaries: [],
          missing_monetization_link: null,
          invalidation_point: null,
        },
        supportingAgents: [],
        openQuestions: [],
        createdAt: '2026-03-28T00:00:00Z',
        primaryTurn: {
          run_id: 'run-1',
          agent_name: 'investment_verdict',
          provider: 'codex',
          session_id: 'session-1',
          provider_execution_status: 'degraded',
          turn_index: 1,
          prompt_summary: '',
          response: {
            summary: 'Workflow demand is investable',
            confidence: 0.82,
            claims: [],
            evidence_used: [],
            open_questions: [],
            messages_for_other_agents: [],
            recommended_next_step: '',
          },
          citations: [],
          evidence_refs: [],
          created_at: '2026-03-28T00:00:00Z',
        },
      },
    };
  }

  async getRun() {
    return {
      run: {
        run_id: 'run-1',
        topic: 'Cursor',
        status: 'completed',
        created_at: '2026-03-28T00:00:00Z',
        updated_at: '2026-03-28T00:10:00Z',
        evidence_count: 4,
        providers: ['codex', 'claude'],
      },
    };
  }

  async getRunVerdict() {
    return {
      run_id: 'run-1',
      verdict: {
        run_id: 'run-1',
        summary: 'Watch closely',
        confidence: 0.72,
        beneficiary_mapping: {
          summary: 'Infra leverage',
          direct_winners: [{ name: 'Cursor', category: 'direct_winner', rationale: '', supporting_evidence: [], confidence: 0.8 }],
          public_beneficiaries: [{ name: 'MSFT', category: 'public_beneficiary', rationale: '', supporting_evidence: [], confidence: 0.7 }],
          second_order_beneficiaries: [{ name: 'NVDA', category: 'second_order_beneficiary', rationale: '', supporting_evidence: [], confidence: 0.6 }],
          missing_monetization_link: null,
          invalidation_point: 'seat growth stalls',
        },
        risks: ['valuation'],
      },
    };
  }

  async getRunResearch() {
    return {
      run_id: 'run-1',
      research: {
        run_id: 'run-1',
        status: 'completed',
        findings: [{ agent_name: 'research', summary: 'Need more pricing evidence', confidence: 0.6, claims: [], citations: [], evidence_refs: [], open_questions: [] }],
        latest_turns: [],
      },
    };
  }

  async getResearchRequests() {
    return {
      run_id: 'run-1',
      count: 1,
      requests: [{
        request: {
          runId: 'run-1',
          entity: 'Cursor',
          requestedByAgent: 'research',
          intent: 'pricing',
          requestKind: 'request_human_note',
          question: 'What are teams paying now?',
          whyNow: 'Need monetization proof',
          priority: 'normal',
        },
        submissionId: 'submission-1',
        status: 'pending_human',
        evidenceIds: [],
      }],
    };
  }
}

describe('RunCommandService', () => {
  it('summarizes run start with degraded verdict visibility', async () => {
    const service = new RunCommandService(new FakeOrchestratorClient() as never);
    const content = await service.start('Cursor');
    expect(content).toContain('subject=Cursor');
    expect(content).toContain('run_id=run-1');
    expect(content).toContain('triage=approved');
    expect(content).toContain('degraded=true');
    expect(content).toContain('topic=Cursor');
    expect(content).toContain('public: MSFT');
  });

  it('formats status, verdict, and request views', async () => {
    const service = new RunCommandService(new FakeOrchestratorClient() as never);
    expect(await service.status('run-1')).toContain('providers=codex, claude');
    expect(await service.verdict('run-1')).toContain('second_order: NVDA');
    expect(await service.requests('run-1')).toContain('intent=pricing');
  });
});
