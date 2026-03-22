import type {
  AgentSignal,
  GuildReportConfig,
  KnowledgeEntry,
  ReportDetailLevel,
  PredictorRequest,
  PredictorResponse,
  ReportRunMode
} from '../types/domain.js';
import { GuildConfigStore } from './guildConfigStore.js';

export type ReportDispatch = {
  channelId: string;
  content: string;
  config: GuildReportConfig;
  response: PredictorResponse;
};

export interface PredictorGateway {
  generateReport(request: PredictorRequest): Promise<PredictorResponse>;
  getAgentSignals(): Promise<AgentSignal[]>;
  runAgents(agents?: string[]): Promise<AgentSignal[]>;
  listKnowledge(): Promise<KnowledgeEntry[]>;
  addKnowledge(content: string, tags?: string[]): Promise<KnowledgeEntry>;
  removeKnowledge(id: string): Promise<void>;
}

function todayInTimeZone(timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(new Date());
}

export class ReportService {
  readonly predictor: PredictorGateway;

  constructor(
    private readonly store: GuildConfigStore,
    predictor: PredictorGateway,
    private readonly defaultTimeZone: string
  ) {
    this.predictor = predictor;
  }

  async getStatus(guildId: string): Promise<GuildReportConfig | undefined> {
    return this.store.get(guildId);
  }

  async ensureGuild(guildId: string, reportChannelId: string): Promise<GuildReportConfig> {
    return this.store.ensureGuild(guildId, {
      reportChannelId,
      timezone: this.defaultTimeZone
    });
  }

  async addTicker(guildId: string, reportChannelId: string, ticker: string): Promise<GuildReportConfig> {
    await this.ensureGuild(guildId, reportChannelId);
    return this.store.addTicker(guildId, ticker);
  }

  async removeTicker(guildId: string, reportChannelId: string, ticker: string): Promise<GuildReportConfig> {
    await this.ensureGuild(guildId, reportChannelId);
    return this.store.removeTicker(guildId, ticker);
  }

  async generateForGuild(
    guildId: string,
    fallbackChannelId: string,
    mode: ReportRunMode,
    detail: ReportDetailLevel
  ): Promise<ReportDispatch> {
    const config = await this.ensureGuild(guildId, fallbackChannelId);
    if (!config.enabled) {
      throw new Error('리포트 전송이 비활성화되어 있습니다.');
    }

    if (config.tickers.length === 0) {
      throw new Error('관심 종목이 없습니다. `/watchlist-add ticker:005930` 형태로 먼저 등록하세요.');
    }

    const response = await this.predictor.generateReport({
      guildId,
      tickers: config.tickers,
      asOfDate: todayInTimeZone(config.timezone),
      mode,
      detail
    });

    return {
      channelId: config.reportChannelId,
      content: response.markdown,
      config,
      response
    };
  }

  async markRun(
    guildId: string,
    result: { status: 'ok' | 'error'; mode: ReportRunMode; error?: string }
  ): Promise<void> {
    await this.store.markRun(guildId, result);
  }

  async listConfigs(): Promise<GuildReportConfig[]> {
    return this.store.list();
  }
}
