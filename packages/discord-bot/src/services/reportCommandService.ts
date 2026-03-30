import type { ReportDetailLevel } from '../types/domain.js';
import type { ReportDispatch, ReportService } from './reportService.js';
import type { ActionRequest, NormalizedEquityIdentity } from '@agentic/shared-types';

type ResolvedEquityIdentity = NormalizedEquityIdentity & {
  resolved: true;
  ticker: string;
  company_name: string;
};

function formatResolvedIdentity(identity: NormalizedEquityIdentity): string {
  if (!identity.resolved || !identity.ticker || !identity.company_name) {
    return identity.input;
  }
  return `${identity.company_name} (\`${identity.ticker}\`)`;
}

export class ReportCommandService {
  constructor(
    private readonly reports: ReportService,
    private readonly resolveDefaultReportChannelId: (guildId: string) => string,
    private readonly runReport: (
      guildId: string,
      fallbackChannelId: string,
      mode: 'manual',
      detail: ReportDetailLevel,
    ) => Promise<ReportDispatch>,
    private readonly normalizeEquity: (input: string) => Promise<NormalizedEquityIdentity>,
    private readonly loadDetailedReport: (runId?: string) => Promise<string>,
  ) {}

  private async requireResolvedIdentity(input: string): Promise<ResolvedEquityIdentity> {
    const identity = await this.normalizeEquity(input);
    if (!identity.resolved || !identity.ticker || !identity.company_name) {
      throw new Error(`종목 정규화에 실패했습니다: \`${input}\``);
    }
    return identity as ResolvedEquityIdentity;
  }

  async addTicker(guildId: string, rawTicker: string): Promise<string> {
    const identity = await this.requireResolvedIdentity(rawTicker);
    const config = await this.reports.addTicker(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
      identity.ticker,
      {
        assetKey: identity.asset_key ?? `stock:${identity.ticker}`,
        companyName: identity.company_name,
        market: identity.market,
        exchange: identity.exchange,
        instrumentCode: identity.instrument_code,
        normalizationSource: identity.normalization_source,
      },
    );
    return [
      `관심 종목 등록 완료: ${formatResolvedIdentity(identity)}`,
      `리포트 채널: <#${config.reportChannelId}>`,
      `현재 목록: ${config.watchlist?.map((entry) => `${entry.companyName} (${entry.ticker})`).join(', ') || config.tickers.join(', ')}`,
    ].join('\n');
  }

  async removeTicker(guildId: string, rawTicker: string): Promise<string> {
    const identity = await this.requireResolvedIdentity(rawTicker);
    const config = await this.reports.removeTicker(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
      identity.ticker,
    );
    return config.tickers.length > 0
      ? `관심 종목 삭제 완료: ${formatResolvedIdentity(identity)}\n현재 목록: ${config.watchlist?.map((entry) => `${entry.companyName} (${entry.ticker})`).join(', ') || config.tickers.join(', ')}`
      : `관심 종목 삭제 완료: ${formatResolvedIdentity(identity)}\n현재 목록이 비어 있습니다.`;
  }

  async listWatchlist(guildId: string): Promise<string> {
    const config = await this.reports.ensureGuild(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
    );
    const watchlistSummary =
      config.watchlist && config.watchlist.length > 0
        ? config.watchlist
            .map((entry) => `${entry.companyName} (\`${entry.ticker}\`)`)
            .join(', ')
        : config.tickers.length > 0
          ? config.tickers.join(', ')
          : '(비어 있음)';
    return [
      `리포트 채널: <#${config.reportChannelId}>`,
      `시간대: ${config.timezone}`,
      `관심 종목: ${watchlistSummary}`,
      `자동 발송: ${config.enabled ? '활성화' : '비활성화'}`,
    ].join('\n');
  }

  async run(guildId: string): Promise<string> {
    const fallbackChannelId = this.resolveDefaultReportChannelId(guildId);
    const dispatch = await this.runReport(guildId, fallbackChannelId, 'manual', 'summary');
    return `요약 리포트를 <#${dispatch.channelId}>에 전송했습니다.`;
  }

  async detail(runId?: string): Promise<string> {
    return this.loadDetailedReport(runId);
  }

  async status(guildId: string): Promise<string> {
    const config = await this.reports.ensureGuild(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
    );
    const last = config.lastReport
      ? `${config.lastReport.status} / ${config.lastReport.mode} / ${config.lastReport.ranAt}${config.lastReport.error ? ` / ${config.lastReport.error}` : ''}`
      : '실행 이력 없음';
    return [
      `리포트 채널: <#${config.reportChannelId}>`,
      `관심 종목 수: ${config.tickers.length}`,
      `자동 발송: ${config.enabled ? `활성화 (${config.timezone})` : '비활성화'}`,
      `최근 실행: ${last}`,
    ].join('\n');
  }

  async applyWatchlistAction(
    guildId: string,
    action: ActionRequest['action'],
    rawTicker: string,
    displayName?: string,
  ): Promise<string> {
    const identity = await this.requireResolvedIdentity(rawTicker);
    if (action === 'watchlist_add') {
      await this.reports.addTicker(
        guildId,
        this.resolveDefaultReportChannelId(guildId),
        identity.ticker,
        {
          assetKey: identity.asset_key ?? `stock:${identity.ticker}`,
          companyName: identity.company_name ?? displayName ?? identity.ticker,
          market: identity.market,
          exchange: identity.exchange,
          instrumentCode: identity.instrument_code,
          normalizationSource: identity.normalization_source,
        },
      );
      return `watchlist 자동 추가: ${displayName ?? identity.company_name ?? identity.ticker} (\`${identity.ticker}\`)`;
    }
    await this.reports.removeTicker(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
      identity.ticker,
    );
    return `watchlist 자동 제거: ${displayName ?? identity.company_name ?? identity.ticker} (\`${identity.ticker}\`)`;
  }
}
