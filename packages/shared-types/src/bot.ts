// ---------------------------------------------------------------
// Bot & legacy predictor types (migrated from src/types/domain.ts)
// ---------------------------------------------------------------

export type JobRequest = {
  actionId: string;
  userId: string;
  guildId: string;
  channelId: string;
  transcript: string;
  createdAt: number;
};

export type JobResult = {
  actionId: string;
  executed: boolean;
  summary: string;
  finishedAt: number;
};

export type Transcript = {
  text: string;
  confidence?: number;
  durationMs: number;
};

export type PendingAction = {
  id: string;
  transcript: Transcript;
  createdAt: number;
  expiresAt: number;
  userId: string;
  guildId: string;
  channelId: string;
};

export type NotifyConfig = {
  channelId: string;
  intervalSec: number;
};

export type ReportRunMode = 'scheduled' | 'manual' | 'api';
export type ReportDetailLevel = 'summary' | 'full';

export type ReportRunRecord = {
  status: 'ok' | 'error';
  ranAt: string;
  mode: ReportRunMode;
  error?: string;
};

export type GuildReportConfig = {
  guildId: string;
  reportChannelId: string;
  tickers: string[];
  enabled: boolean;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  lastReport?: ReportRunRecord;
};

export type GuildReportConfigStore = {
  version: 1;
  guilds: Record<string, GuildReportConfig>;
};

export type PredictorRequest = {
  guildId: string;
  tickers: string[];
  asOfDate: string;
  mode: ReportRunMode;
  detail: ReportDetailLevel;
};

export type PredictorReportItem = {
  ticker: string;
  headline: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  priceSummary?: string;
  news: string[];
  disclosures: string[];
  bullCase: string[];
  bearCase: string[];
  watchPoints: string[];
  debateLog: {
    bull: {
      stance: string;
      confidence: number;
      arguments: string[];
    };
    bear: {
      stance: string;
      confidence: number;
      arguments: string[];
    };
    judge: {
      verdict: string;
      rationale: string[];
      selectedRisks: string[];
      selectedWatchPoints: string[];
    };
  };
};

export type PredictorResponse = {
  detail: ReportDetailLevel;
  summary: string;
  marketCommentary: string;
  markdown: string;
  items: PredictorReportItem[];
  risks: string[];
  generatedAt: string;
  sources: string[];
};

export type SignalValue = 'bullish' | 'caution' | 'bearish' | 'neutral';
export type SignalHorizon = '1d' | '1w' | '1-3m' | '3-6m' | '6m+' | 'unknown';

export type AgentSignal = {
  agent: string;
  signal: SignalValue;
  horizon: SignalHorizon;
  confidence: number;
  summary: string;
  key_factors: string[];
  updated_at: string;
};

export type KnowledgeEntry = {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
};
