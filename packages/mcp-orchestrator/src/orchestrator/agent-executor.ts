import type { AgentTurn, AgentResponse, EvidenceBundle } from '@agentic/shared-types';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { PromptComposer } from '../prompt/composer.js';
import type { RunStore } from './run-store.js';

export interface ExecuteAgentParams {
  runId: string;
  agentName: string;
  providers: string[];
  evidenceBundle?: EvidenceBundle;
  otherAgentMessages?: Array<{ from: string; content: string }>;
}

const DEFAULT_RESPONSE: AgentResponse = {
  summary: 'Unable to parse provider response',
  confidence: 0,
  claims: [],
  evidence_used: [],
  open_questions: ['Response parsing failed'],
  messages_for_other_agents: [],
  recommended_next_step: 'retry',
};

function tryParseResponse(text: string): AgentResponse {
  try {
    // Try to extract JSON from the response (may be wrapped in markdown code fences)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
    const parsed = JSON.parse(jsonStr) as AgentResponse;
    // Validate required fields exist
    if (typeof parsed.summary === 'string' && typeof parsed.confidence === 'number') {
      return {
        summary: parsed.summary,
        confidence: parsed.confidence,
        claims: parsed.claims ?? [],
        evidence_used: parsed.evidence_used ?? [],
        open_questions: parsed.open_questions ?? [],
        messages_for_other_agents: parsed.messages_for_other_agents ?? [],
        recommended_next_step: parsed.recommended_next_step ?? '',
      };
    }
    return { ...DEFAULT_RESPONSE, summary: text.slice(0, 500) };
  } catch {
    return { ...DEFAULT_RESPONSE, summary: text.slice(0, 500) };
  }
}

export class AgentExecutor {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly sessionStore: SessionStore,
    private readonly promptComposer: PromptComposer,
    private readonly runStore: RunStore,
  ) {}

  async executeAgent(params: ExecuteAgentParams): Promise<AgentTurn[]> {
    const turns: AgentTurn[] = [];
    const existingTurns = this.runStore.getTurns(params.runId);

    for (const providerName of params.providers) {
      const adapter = this.registry.get(providerName);
      if (!adapter) continue;

      // 1. Get or create session
      let session = this.sessionStore.getSession(params.agentName, providerName);
      if (!session) {
        session = this.sessionStore.createSession(params.agentName, providerName);
      }

      // 2. Compose prompt
      const prompt = await this.promptComposer.compose({
        agentName: params.agentName,
        provider: providerName,
        evidenceBundle: params.evidenceBundle,
        otherAgentMessages: params.otherAgentMessages,
      });

      // 3. Execute
      const result = await adapter.execute(prompt, session.session_id);

      // 4. Parse response
      const response = tryParseResponse(result.text);

      // 5. Create turn
      const turn: AgentTurn = {
        run_id: params.runId,
        agent_name: params.agentName,
        provider: providerName,
        session_id: result.sessionId,
        turn_index: existingTurns.filter(
          (t) => t.agent_name === params.agentName && t.provider === providerName,
        ).length,
        prompt_summary: prompt.slice(0, 200),
        response,
        citations: response.evidence_used,
        evidence_refs: params.evidenceBundle
          ? params.evidenceBundle.evidence_items.map((e: { evidence_id: string }) => e.evidence_id)
          : [],
        created_at: new Date().toISOString(),
      };

      // 6. Save
      this.runStore.saveTurn(turn);
      this.sessionStore.updateSession(session.session_id, turn);
      turns.push(turn);
    }

    return turns;
  }
}
