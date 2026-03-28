import { describe, expect, it } from 'vitest';
import { HumanInputFollowUpService } from '../src/services/humanInputFollowUpService.js';

class MockReportCommands {
  readonly calls: Array<{ guildId: string; action: string; ticker: string }> = [];

  async applyWatchlistAction(
    guildId: string,
    action: 'watchlist_add' | 'watchlist_remove',
    ticker: string,
    displayName?: string,
  ): Promise<string> {
    this.calls.push({ guildId, action, ticker });
    return `watchlist ${action}: ${displayName ?? ticker}`;
  }
}

class MockOrchestratorClient {
  readonly requests: unknown[] = [];

  async submitInvestmentIntake(body: unknown) {
    this.requests.push(body);
    return {
      intake: {
        intake_id: 'intake-1',
      },
      dossiers: [
        {
          display_name: '삼성전자',
        },
      ],
    };
  }
}

describe('HumanInputFollowUpService', () => {
  it('auto-applies low-risk watchlist actions and forwards investment notes', async () => {
    const reportCommands = new MockReportCommands();
    const orchestrator = new MockOrchestratorClient();
    const service = new HumanInputFollowUpService(
      reportCommands as never,
      orchestrator as never,
    );

    const messages = await service.handle({
      guildId: 'guild-1',
      channelRef: 'https://discord.example/message/1',
      rawInput: '삼성전자 와치리스트에 추가해. 그리고 HBM 스터디 메모도 남긴다.',
      sourceSubmissionId: 'submission-1',
      interpretation: {
        route: 'human_analyst_note',
        collector_route: 'human_analyst_note',
        input_kind: 'mixed',
        confidence: 0.95,
        rationale: 'mixed',
        title: '삼성전자 note',
        entities: ['삼성전자'],
        signal_type: 'manual',
        geo: 'global',
        url: '',
        trust_score: 0.9,
        freshness_ttl: 86400,
        observation: 'note',
        why_now: 'why now',
        beneficiary_hints: ['HBM'],
        research_questions: ['실적 반영 시점은 언제인가?'],
        source_refs: [],
        supporting_points: ['HBM demand'],
        study_type: 'analysis_note',
        dataset_name: 'discord_human_input',
        notes: '',
        evidence_items: [],
        action_requests: [
          {
            action: 'watchlist_add',
            asset_type: 'stock',
            asset_key: 'stock:005930',
            ticker: '005930',
            display_name: '삼성전자',
            confidence: 0.96,
          },
        ],
        handoff_targets: ['investment_module'],
        asset_candidates: [
          {
            asset_type: 'stock',
            asset_key: 'stock:005930',
            display_name: '삼성전자',
            ticker: '005930',
            market: 'KRX',
            confidence: 0.96,
          },
        ],
        investment_note: {
          title: '삼성전자 note',
          summary: 'HBM note',
          structured_summary: ['HBM demand'],
          why_it_might_matter: 'AI server mix',
          beneficiary_hints: ['HBM'],
          open_questions: ['timing'],
          references: [],
          asset_candidates: [],
          status: 'resolved',
        },
        user_message: '자유 형식 스터디 입력으로 해석했습니다.',
      },
    });

    expect(reportCommands.calls).toEqual([
      { guildId: 'guild-1', action: 'watchlist_add', ticker: '005930' },
    ]);
    expect(orchestrator.requests).toHaveLength(1);
    expect(messages).toEqual([
      'watchlist watchlist_add: 삼성전자',
      '투자 메모 저장: intake-1 | dossier=삼성전자',
    ]);
  });

  it('does not auto-apply low-confidence or non-stock actions', async () => {
    const reportCommands = new MockReportCommands();
    const orchestrator = new MockOrchestratorClient();
    const service = new HumanInputFollowUpService(
      reportCommands as never,
      orchestrator as never,
    );

    const messages = await service.handle({
      guildId: 'guild-1',
      rawInput: '부동산 스터디 메모',
      sourceSubmissionId: 'submission-2',
      interpretation: {
        route: 'human_analyst_note',
        collector_route: 'human_analyst_note',
        input_kind: 'study_note',
        confidence: 0.81,
        rationale: 'study_note',
        title: '부동산 note',
        entities: [],
        signal_type: 'manual',
        geo: 'global',
        url: '',
        trust_score: 0.9,
        freshness_ttl: 86400,
        observation: 'note',
        why_now: '',
        beneficiary_hints: [],
        research_questions: [],
        source_refs: [],
        supporting_points: [],
        study_type: 'analysis_note',
        dataset_name: 'discord_human_input',
        notes: '',
        evidence_items: [],
        action_requests: [],
        handoff_targets: [],
        asset_candidates: [
          {
            asset_type: 'real_estate',
            display_name: '잠실 재건축',
            confidence: 0.6,
          },
        ],
        investment_note: undefined,
        user_message: '자유 형식 입력을 구조화해 처리합니다.',
      },
    });

    expect(reportCommands.calls).toEqual([]);
    expect(orchestrator.requests).toEqual([]);
    expect(messages).toEqual([]);
  });
});
