import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type TextChannel
} from 'discord.js';
import { env } from '../config.js';
import { ActionOrchestrator } from '../services/actionOrchestrator.js';
import { CollectorClient } from '../services/collectorClient.js';
import { DiscordIngestRouter } from '../services/discordIngestRouter.js';
import { NotificationScheduler } from '../services/notificationScheduler.js';
import { ProviderHealthMonitor } from '../services/providerHealthMonitor.js';
import { ReportService, type ReportDispatch } from '../services/reportService.js';
import { SpeechSegmenter } from '../services/speechSegmenter.js';
import { VoiceCaptureService } from '../services/voiceCaptureService.js';
import { MockSttProvider, type SttProvider } from '../stt/provider.js';
import type { ReportDetailLevel, ReportRunMode } from '../types/domain.js';
import { commandJson } from './commands.js';
import {
  detectChannelRoutingWarnings,
  resolveProviderAlertChannelIds,
} from './channelRouting.js';

function normalizeTicker(input: string): string {
  return input.trim().toUpperCase();
}

function isValidTicker(input: string): boolean {
  return /^\d{6}$/.test(input);
}

function chunkMessage(content: string, maxLength = 1_900): string[] {
  const normalized = content.trim();
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const splitAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const boundary = splitAt > 200 ? splitAt : maxLength;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export class BotApp {
  readonly client: Client;
  readonly scheduler: NotificationScheduler;
  readonly orchestrator: ActionOrchestrator;
  readonly reports: ReportService;
  readonly collector: CollectorClient;
  readonly ingestRouter: DiscordIngestRouter;
  readonly providerHealthMonitor?: ProviderHealthMonitor;
  readonly segmenter: SpeechSegmenter;
  readonly stt: SttProvider;
  readonly voiceCapture: VoiceCaptureService;

  constructor(
    orchestrator: ActionOrchestrator,
    scheduler: NotificationScheduler,
    reports: ReportService,
    collector: CollectorClient,
    providerHealthMonitor?: ProviderHealthMonitor,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
      ],
      partials: [Partials.Channel]
    });
    this.orchestrator = orchestrator;
    this.scheduler = scheduler;
    this.reports = reports;
    this.collector = collector;
    this.ingestRouter = new DiscordIngestRouter(collector);
    this.providerHealthMonitor = providerHealthMonitor;
    this.segmenter = new SpeechSegmenter();
    this.stt = new MockSttProvider();
    this.voiceCapture = new VoiceCaptureService(this.client, async (input) => {
      try {
        const normalized = this.segmenter.normalize(input.pcm16le);
        if (!normalized) {
          return;
        }
        const transcript = await this.stt.transcribePcm16le(normalized, input.sampleRate);

        const action = this.orchestrator.createPending({
          transcript,
          userId: input.userId,
          guildId: input.guildId,
          channelId: this.resolveTextChannelId(input.guildId)
        });

        const channel = await this.client.channels.fetch(action.channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return;
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`action:run:${action.id}`)
            .setLabel('실행')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`action:skip:${action.id}`)
            .setLabel('스킵')
            .setStyle(ButtonStyle.Secondary)
        );

        await channel.send({
          content: [
            `<@${input.userId}> 음성 인식 결과:`,
            `"${transcript.text}"`,
            `승인하면 작업을 실행합니다. (만료 ${Math.round((action.expiresAt - Date.now()) / 1000)}초)`
          ].join('\n'),
          components: [row]
        });
      } catch (error) {
        console.error('Voice pipeline error', error);
      }
    });

    this.client.once(Events.ClientReady, async () => {
      this.logChannelRoutingWarnings();
      await this.registerSlashCommands();
      await this.initializeReportSchedules();
      this.startProviderHealthMonitor();
      console.log(`Logged in as ${this.client.user?.tag}`);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleSlash(interaction);
          return;
        }

        if (interaction.isButton()) {
          const [prefix, verb, actionId] = interaction.customId.split(':');
          if (prefix !== 'action' || !verb || !actionId) {
            return;
          }

          if (verb === 'run') {
            const outcome = await this.orchestrator.execute(actionId);
            if (outcome.status === 'executed') {
              await interaction.update({ content: `실행 완료: ${outcome.result.summary}`, components: [] });
            } else if (outcome.status === 'expired') {
              await interaction.update({ content: '요청이 만료되어 실행되지 않았습니다.', components: [] });
            } else {
              await interaction.update({ content: '대기중인 요청을 찾을 수 없습니다.', components: [] });
            }
          } else if (verb === 'skip') {
            const outcome = this.orchestrator.skip(actionId);
            if (outcome.status === 'skipped') {
              await interaction.update({ content: '요청을 스킵했습니다.', components: [] });
            } else if (outcome.status === 'expired') {
              await interaction.update({ content: '요청이 이미 만료되었습니다.', components: [] });
            } else {
              await interaction.update({ content: '대기중인 요청을 찾을 수 없습니다.', components: [] });
            }
          }
        }
      } catch (error) {
        console.error('Interaction error', error);
        if (interaction.isRepliable() && interaction.deferred) {
          await interaction.editReply({ content: '처리 중 오류가 발생했습니다.' });
          return;
        }
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '처리 중 오류가 발생했습니다.', ephemeral: true });
        }
      }
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleIngestMessage(message);
      } catch (error) {
        console.error('Discord ingest routing error', error);
      }
    });
  }

  async start(): Promise<void> {
    await this.client.login(env.DISCORD_TOKEN);
  }

  async stop(): Promise<void> {
    this.scheduler.clearAll();
    this.providerHealthMonitor?.stop();
    this.orchestrator.dispose();
    this.client.destroy();
  }

  async health(): Promise<Record<string, unknown>> {
    const stt = await this.stt.health();
    const configs = await this.reports.listConfigs();
    return {
      discordReady: this.client.isReady(),
      activeSchedules: this.scheduler.activeSchedules(),
      configuredGuildReports: configs.length,
      pendingActions: this.orchestrator.stats().pendingCount,
      activeVoiceSessions: this.voiceCapture.activeCount(),
      providerHealthMonitorRunning: this.providerHealthMonitor?.isRunning() ?? false,
      stt
    };
  }

  private async registerSlashCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
    if (env.DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
        body: commandJson
      });
      return;
    }

    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: commandJson });
  }

  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: '길드에서만 사용할 수 있습니다.', ephemeral: true });
      return;
    }

    switch (interaction.commandName) {
      case 'ping': {
        await interaction.reply({
          content: `pong\nactiveSchedules=${this.scheduler.activeSchedules()}\npendingActions=${this.orchestrator.stats().pendingCount}`,
          ephemeral: true
        });
        return;
      }
      case 'watchlist-add': {
        const ticker = normalizeTicker(interaction.options.getString('ticker', true));
        if (!isValidTicker(ticker)) {
          await interaction.reply({
            content: '종목 코드는 6자리 숫자여야 합니다. 예: `005930`',
            ephemeral: true
          });
          return;
        }

        try {
          const config = await this.reports.addTicker(
            interaction.guildId,
            this.resolveDefaultReportChannelId(interaction.guildId),
            ticker,
          );
          if (config.enabled && config.tickers.length > 0) {
            this.scheduler.setSchedule(interaction.guildId, this.runScheduledReport.bind(this));
          }
          await interaction.reply({
            content: `관심 종목 등록 완료: \`${ticker}\`\n리포트 채널: <#${config.reportChannelId}>\n현재 목록: ${config.tickers.join(', ')}`,
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `종목 등록 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'watchlist-remove': {
        try {
          const ticker = normalizeTicker(interaction.options.getString('ticker', true));
          const config = await this.reports.removeTicker(
            interaction.guildId,
            this.resolveDefaultReportChannelId(interaction.guildId),
            ticker,
          );
          if (config.enabled && config.tickers.length > 0) {
            this.scheduler.setSchedule(interaction.guildId, this.runScheduledReport.bind(this));
          } else {
            this.scheduler.clearSchedule(interaction.guildId);
          }
          await interaction.reply({
            content: config.tickers.length > 0
              ? `관심 종목 삭제 완료: \`${ticker}\`\n현재 목록: ${config.tickers.join(', ')}`
              : `관심 종목 삭제 완료: \`${ticker}\`\n현재 목록이 비어 있습니다.`,
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `종목 삭제 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'watchlist-list': {
        try {
          const config = await this.reports.ensureGuild(
            interaction.guildId,
            this.resolveDefaultReportChannelId(interaction.guildId),
          );
          await interaction.reply({
            content: [
              `리포트 채널: <#${config.reportChannelId}>`,
              `시간대: ${config.timezone}`,
              `관심 종목: ${config.tickers.length > 0 ? config.tickers.join(', ') : '(비어 있음)'}`,
              `자동 발송: ${config.enabled ? `평일 ${env.REPORT_TIME_KST}` : '비활성화'}`
            ].join('\n'),
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `목록 조회 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'report-summary':
      case 'report-full': {
        const detail: ReportDetailLevel = interaction.commandName === 'report-summary' ? 'summary' : 'full';
        await interaction.deferReply({ ephemeral: true });
        try {
          const dispatch = await this.runReport(
            interaction.guildId,
            this.resolveDefaultReportChannelId(interaction.guildId),
            'manual',
            detail,
          );
          await interaction.editReply({
            content: [
              `${detail === 'summary' ? '요약' : '전체'} 리포트 전송 완료: <#${dispatch.channelId}>`,
              `종목 수: ${dispatch.config.tickers.length}`,
              `생성 시각: ${dispatch.response.generatedAt}`
            ].join('\n')
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '알 수 없는 오류';
          await interaction.editReply({ content: `리포트 생성 실패: ${message}` });
        }
        return;
      }
      case 'report-status': {
        try {
          const config = await this.reports.ensureGuild(
            interaction.guildId,
            this.resolveDefaultReportChannelId(interaction.guildId),
          );
          const last = config.lastReport
            ? `${config.lastReport.status} / ${config.lastReport.mode} / ${config.lastReport.ranAt}${config.lastReport.error ? ` / ${config.lastReport.error}` : ''}`
            : '실행 이력 없음';
          await interaction.reply({
            content: [
              `리포트 채널: <#${config.reportChannelId}>`,
              `관심 종목 수: ${config.tickers.length}`,
              `자동 발송 시각: 평일 ${env.REPORT_TIME_KST} ${env.REPORT_TIMEZONE} (summary)`,
              `최근 실행: ${last}`
            ].join('\n'),
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `리포트 상태 조회 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'voice-start': {
        const guildId = interaction.guildId;
        const guild = interaction.guild;
        if (!guildId || !guild) {
          await interaction.reply({ content: '길드 정보를 확인할 수 없습니다.', ephemeral: true });
          return;
        }

        const selected = interaction.options.getChannel('channel');
        let voiceChannelId = selected?.id;

        if (!voiceChannelId) {
          const member = interaction.member as GuildMember;
          voiceChannelId = member.voice.channelId ?? undefined;
        }

        if (!voiceChannelId) {
          await interaction.reply({
            content: '음성 채널을 지정하거나 먼저 접속해 주세요.',
            ephemeral: true
          });
          return;
        }

        try {
          const voiceChannel = await guild.channels.fetch(voiceChannelId);
          if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
            await interaction.reply({ content: '유효한 음성 채널이 아닙니다.', ephemeral: true });
            return;
          }

          await this.voiceCapture.start(
            guildId,
            voiceChannelId,
            guild.voiceAdapterCreator as Parameters<VoiceCaptureService['start']>[2]
          );
          await interaction.reply({
            content: `음성 수집 시작: ${voiceChannel.name}`,
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `음성 수집 시작 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'voice-stop': {
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: '길드 정보를 확인할 수 없습니다.', ephemeral: true });
          return;
        }
        await this.voiceCapture.stop(guildId);
        await interaction.reply({ content: '음성 수집을 중지했습니다.', ephemeral: true });
        return;
      }
      case 'agent-status': {
        await interaction.deferReply({ ephemeral: true });
        try {
          const signals = await this.reports.analysis.getAgentSignals();
          if (signals.length === 0) {
            await interaction.editReply({ content: '저장된 에이전트 신호가 없습니다. `/agent-run`으로 먼저 실행하세요.' });
            return;
          }
          const lines = signals.map((s) =>
            `**${s.agent}** | ${s.signal.toUpperCase()} (${Math.round(s.confidence * 100)}%) | ${s.horizon}\n${s.summary}`
          );
          await interaction.editReply({ content: lines.join('\n\n') });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `에이전트 신호 조회 실패: ${msg}` });
        }
        return;
      }
      case 'agent-run': {
        await interaction.deferReply({ ephemeral: true });
        const agentName = interaction.options.getString('agent') ?? undefined;
        try {
          const signals = await this.reports.analysis.runAgents(agentName ? [agentName] : undefined);
          const names = signals.map((s) => s.agent).join(', ');
          await interaction.editReply({ content: `에이전트 실행 완료: ${names}\n\n결과를 확인하려면 \`/agent-status\`를 사용하세요.` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `에이전트 실행 실패: ${msg}` });
        }
        return;
      }
      case 'knowledge-add': {
        const content = interaction.options.getString('content', true);
        const tagsRaw = interaction.options.getString('tags') ?? '';
        const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        try {
          const entry = await this.reports.analysis.addKnowledge(content, tags);
          const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          await interaction.reply({
            content: `지식 추가 완료 (ID: \`${entry.id}\`)\n> ${content}${tagStr}`,
            ephemeral: true
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `지식 추가 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'knowledge-list': {
        await interaction.deferReply({ ephemeral: true });
        try {
          const entries = await this.reports.analysis.listKnowledge();
          if (entries.length === 0) {
            await interaction.editReply({ content: '저장된 지식이 없습니다. `/knowledge-add`로 추가하세요.' });
            return;
          }
          const lines = entries.map((e, i) => {
            const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
            return `**${i + 1}.** \`${e.id.slice(0, 8)}\`${tagStr}\n${e.content}`;
          });
          await interaction.editReply({ content: lines.join('\n\n') });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `지식 목록 조회 실패: ${msg}` });
        }
        return;
      }
      case 'knowledge-remove': {
        const id = interaction.options.getString('id', true).trim();
        try {
          await this.reports.analysis.removeKnowledge(id);
          await interaction.reply({ content: `삭제 완료: \`${id}\``, ephemeral: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.reply({ content: `삭제 실패: ${msg}`, ephemeral: true });
        }
        return;
      }
      case 'radar-status': {
        await interaction.deferReply({ ephemeral: true });
        try {
          const status = await this.collector.getSourcesStatus();
          const entries = Object.entries(
            status.sources as Record<string, {
              cadence_seconds: number;
              source_tier: number;
              last_run: string | null;
              scheduled: boolean;
            }>
          );
          if (entries.length === 0) {
            await interaction.editReply({ content: '등록된 소스가 없습니다.' });
            return;
          }
          const lines = entries.map(([name, s]) => {
            const scheduled = s.scheduled ? 'ON' : 'OFF';
            const last = s.last_run ?? 'never';
            const cadenceMin = Math.round(s.cadence_seconds / 60);
            return `**${name}** (T${s.source_tier}) | ${scheduled} | 마지막 수집: ${last} | 주기: ${cadenceMin}분`;
          });
          await interaction.editReply({ content: lines.join('\n') });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `소스 상태 조회 실패: ${msg}` });
        }
        return;
      }
      case 'radar-emerging': {
        await interaction.deferReply({ ephemeral: true });
        try {
          const result = await this.collector.getEmergingCandidates();
          if (result.candidates.length === 0) {
            await interaction.editReply({ content: '현재 떠오르는 신호 후보가 없습니다.' });
            return;
          }
          // Show top 15 candidates sorted by emergence_score (desc)
          const top = (result.candidates as Array<{
            entity: string;
            status: string;
            emergence_score: number;
            velocity_score: number;
            source_count: number;
            sources: string[];
            primary_sources?: string[];
          }>)
            .sort((a, b) => b.emergence_score - a.emergence_score)
            .slice(0, 15);
          const header = `📡 **떠오르는 신호 후보** (상위 ${top.length}개 / 전체 ${result.candidates.length}개)\n`;
          const lines = top.map((c, i) => {
            const score = Math.round(c.emergence_score * 100);
            const velocity = Math.round(c.velocity_score * 100);
            const sources = (c.sources.length > 0 ? c.sources : (c.primary_sources ?? [])).join(', ');
            return `${i + 1}. **${c.entity}** [${c.status}] | 출현: ${score}% | 속도: ${velocity}% | 소스(${c.source_count}): ${sources}`;
          });
          const content = header + lines.join('\n');
          await interaction.editReply({ content: content.slice(0, 2000) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `신호 후보 조회 실패: ${msg}` });
        }
        return;
      }
      case 'human-queue': {
        await interaction.deferReply({ ephemeral: true });
        try {
          if (
            env.DISCORD_HUMAN_QUEUE_CHANNEL_IDS.size > 0 &&
            !env.DISCORD_HUMAN_QUEUE_CHANNEL_IDS.has(interaction.channelId)
          ) {
            await interaction.editReply({
              content: '이 명령은 지정된 사람 입력 큐 채널에서만 사용하세요.',
            });
            return;
          }
          const limit = interaction.options.getInteger('limit') ?? 10;
          const result = await this.collector.listSubmissions('pending_human', 'human_analyst_note', limit);
          if (result.count === 0) {
            await interaction.editReply({ content: '대기 중인 사람 입력 요청이 없습니다.' });
            return;
          }

          const lines = result.submissions.map((submission, index) => {
            const metadata = (submission.metadata ?? {}) as Record<string, unknown>;
            const entities = Array.isArray(metadata.entity_candidates)
              ? metadata.entity_candidates.map((value) => String(value)).join(', ')
              : '(none)';
            const question = typeof metadata.question === 'string' ? metadata.question : '(no question)';
            const kind =
              typeof metadata.requested_input_kind === 'string'
                ? metadata.requested_input_kind
                : 'study_result';
            const priority = typeof metadata.priority === 'string' ? metadata.priority : 'normal';
            const requestedBy =
              typeof metadata.requested_by_agent === 'string'
                ? metadata.requested_by_agent
                : 'unknown';
            return [
              `${index + 1}. ${submission.submission_id}`,
              `entity=${entities}`,
              `kind=${kind}`,
              `priority=${priority}`,
              `requested_by=${requestedBy}`,
              `question=${question}`,
            ].join(' | ');
          });

          await interaction.editReply({ content: lines.join('\n').slice(0, 2000) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '알 수 없는 오류';
          await interaction.editReply({ content: `사람 입력 큐 조회 실패: ${msg}` });
        }
        return;
      }
      default:
        await interaction.reply({ content: '지원하지 않는 명령입니다.', ephemeral: true });
    }
  }

  private async handleIngestMessage(message: Message<boolean>): Promise<void> {
    if (!message.inGuild() || message.author.bot) {
      return;
    }

    const result = await this.ingestRouter.handleMessage(message);
    if (!result.handled) {
      return;
    }

    if (result.accepted) {
      try {
        await message.react('📥');
      } catch (error) {
        console.error('Failed to react to ingested message', error);
      }
      return;
    }

    await message.reply({
      content: result.message.slice(0, 1900),
      allowedMentions: { repliedUser: false },
    });
  }

  private async sendToTextChannel(channelId: string, message: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }
    const text = channel as TextChannel;
    for (const chunk of chunkMessage(message)) {
      await text.send(chunk);
    }
  }

  private startProviderHealthMonitor(): void {
    if (!this.providerHealthMonitor) {
      return;
    }
    const channelIds = this.resolveProviderAlertChannelIds();
    if (channelIds.length === 0) {
      return;
    }
    this.providerHealthMonitor.start(async (message) => {
      for (const channelId of channelIds) {
        try {
          await this.sendToTextChannel(channelId, message);
        } catch (error) {
          console.error(`Failed to send provider alert to channel ${channelId}`, error);
        }
      }
    });
  }

  private resolveProviderAlertChannelIds(): string[] {
    return resolveProviderAlertChannelIds({
      providerAlertChannelIds: env.DISCORD_PROVIDER_ALERT_CHANNEL_IDS,
      statusChannelIds: env.DISCORD_STATUS_CHANNEL_IDS,
      defaultTextChannelId: env.DEFAULT_TEXT_CHANNEL_ID,
      dailyReportChannelId: env.DISCORD_DAILY_REPORT_CHANNEL_ID,
    });
  }

  private resolveDefaultReportChannelId(guildId: string): string {
    if (env.DISCORD_DAILY_REPORT_CHANNEL_ID) {
      return env.DISCORD_DAILY_REPORT_CHANNEL_ID;
    }
    return this.resolveTextChannelId(guildId);
  }

  private resolveTextChannelId(guildId: string): string {
    if (env.DEFAULT_TEXT_CHANNEL_ID) {
      return env.DEFAULT_TEXT_CHANNEL_ID;
    }

    const guild = this.client.guilds.cache.get(guildId);
    const preferred = guild?.channels.cache.find((channel) => channel.type === ChannelType.GuildText);
    if (!preferred) {
      throw new Error('텍스트 채널을 찾을 수 없습니다. DEFAULT_TEXT_CHANNEL_ID를 설정하세요.');
    }
    return preferred.id;
  }

  private async initializeReportSchedules(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const defaultChannelId = this.resolveDefaultReportChannelId(guild.id);
        const config = await this.reports.ensureGuild(guild.id, defaultChannelId);
        if (config.enabled && config.tickers.length > 0) {
          this.scheduler.setSchedule(guild.id, this.runScheduledReport.bind(this));
        }
      } catch (error) {
        console.error(`Failed to initialize report schedule for guild ${guild.id}`, error);
      }
    }
  }

  private async runScheduledReport(guildId: string): Promise<void> {
    const fallbackChannelId = this.resolveDefaultReportChannelId(guildId);
    await this.runReport(guildId, fallbackChannelId, 'scheduled', 'summary');
  }

  async runReport(
    guildId: string,
    fallbackChannelId: string,
    mode: ReportRunMode,
    detail: ReportDetailLevel
  ): Promise<ReportDispatch> {
    try {
      const dispatch = await this.reports.generateForGuild(guildId, fallbackChannelId, mode, detail);
      await this.sendToTextChannel(dispatch.channelId, dispatch.content);
      await this.reports.markRun(guildId, { status: 'ok', mode });
      return dispatch;
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      await this.reports.markRun(guildId, { status: 'error', mode, error: message });
      await this.sendToTextChannel(fallbackChannelId, `리포트 생성 실패: ${message}`);
      throw error;
    }
  }

  private logChannelRoutingWarnings(): void {
    for (const warning of detectChannelRoutingWarnings({
      providerAlertChannelIds: env.DISCORD_PROVIDER_ALERT_CHANNEL_IDS,
      statusChannelIds: env.DISCORD_STATUS_CHANNEL_IDS,
      defaultTextChannelId: env.DEFAULT_TEXT_CHANNEL_ID,
      dailyReportChannelId: env.DISCORD_DAILY_REPORT_CHANNEL_ID,
    })) {
      console.warn(`[channel-routing] ${warning}`);
    }
  }
}
