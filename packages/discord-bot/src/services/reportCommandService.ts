import type { ReportDetailLevel } from '../types/domain.js';
import type { ReportDispatch, ReportService } from './reportService.js';

function normalizeTicker(input: string): string {
  return input.trim().toUpperCase();
}

function isValidTicker(input: string): boolean {
  return /^\d{6}$/.test(input);
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
  ) {}

  async addTicker(guildId: string, rawTicker: string): Promise<string> {
    const ticker = normalizeTicker(rawTicker);
    if (!isValidTicker(ticker)) {
      throw new Error('종목 코드는 6자리 숫자여야 합니다. 예: `005930`');
    }
    const config = await this.reports.addTicker(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
      ticker,
    );
    return [
      `관심 종목 등록 완료: \`${ticker}\``,
      `리포트 채널: <#${config.reportChannelId}>`,
      `현재 목록: ${config.tickers.join(', ')}`,
    ].join('\n');
  }

  async removeTicker(guildId: string, rawTicker: string): Promise<string> {
    const ticker = normalizeTicker(rawTicker);
    if (!isValidTicker(ticker)) {
      throw new Error('종목 코드는 6자리 숫자여야 합니다. 예: `005930`');
    }
    const config = await this.reports.removeTicker(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
      ticker,
    );
    return config.tickers.length > 0
      ? `관심 종목 삭제 완료: \`${ticker}\`\n현재 목록: ${config.tickers.join(', ')}`
      : `관심 종목 삭제 완료: \`${ticker}\`\n현재 목록이 비어 있습니다.`;
  }

  async listWatchlist(guildId: string): Promise<string> {
    const config = await this.reports.ensureGuild(
      guildId,
      this.resolveDefaultReportChannelId(guildId),
    );
    return [
      `리포트 채널: <#${config.reportChannelId}>`,
      `시간대: ${config.timezone}`,
      `관심 종목: ${config.tickers.length > 0 ? config.tickers.join(', ') : '(비어 있음)'}`,
      `자동 발송: ${config.enabled ? '활성화' : '비활성화'}`,
    ].join('\n');
  }

  async run(guildId: string, detail: ReportDetailLevel): Promise<string> {
    const fallbackChannelId = this.resolveDefaultReportChannelId(guildId);
    const dispatch = await this.runReport(guildId, fallbackChannelId, 'manual', detail);
    return `${detail === 'summary' ? '요약' : '전체'} 리포트를 <#${dispatch.channelId}>에 전송했습니다.`;
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
}
