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
  type TextChannel
} from 'discord.js';
import { env } from '../config.js';
import { ActionOrchestrator } from '../services/actionOrchestrator.js';
import { NotificationScheduler } from '../services/notificationScheduler.js';
import { ReportService, type ReportDispatch } from '../services/reportService.js';
import { SpeechSegmenter } from '../services/speechSegmenter.js';
import { VoiceCaptureService } from '../services/voiceCaptureService.js';
import { MockSttProvider, type SttProvider } from '../stt/provider.js';
import type { ReportDetailLevel, ReportRunMode } from '../types/domain.js';
import { commandJson } from './commands.js';

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
  readonly segmenter: SpeechSegmenter;
  readonly stt: SttProvider;
  readonly voiceCapture: VoiceCaptureService;

  constructor(
    orchestrator: ActionOrchestrator,
    scheduler: NotificationScheduler,
    reports: ReportService
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates
      ],
      partials: [Partials.Channel]
    });
    this.orchestrator = orchestrator;
    this.scheduler = scheduler;
    this.reports = reports;
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
      await this.registerSlashCommands();
      await this.initializeReportSchedules();
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
  }

  async start(): Promise<void> {
    await this.client.login(env.DISCORD_TOKEN);
  }

  async stop(): Promise<void> {
    this.scheduler.clearAll();
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

        const config = await this.reports.addTicker(interaction.guildId, interaction.channelId, ticker);
        if (config.enabled && config.tickers.length > 0) {
          this.scheduler.setSchedule(interaction.guildId, this.runScheduledReport.bind(this));
        }
        await interaction.reply({
          content: `관심 종목 등록 완료: \`${ticker}\`\n리포트 채널: <#${config.reportChannelId}>\n현재 목록: ${config.tickers.join(', ')}`,
          ephemeral: true
        });
        return;
      }
      case 'watchlist-remove': {
        const ticker = normalizeTicker(interaction.options.getString('ticker', true));
        const config = await this.reports.removeTicker(interaction.guildId, interaction.channelId, ticker);
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
        return;
      }
      case 'watchlist-list': {
        const config = await this.reports.ensureGuild(interaction.guildId, interaction.channelId);
        await interaction.reply({
          content: [
            `리포트 채널: <#${config.reportChannelId}>`,
            `시간대: ${config.timezone}`,
            `관심 종목: ${config.tickers.length > 0 ? config.tickers.join(', ') : '(비어 있음)'}`,
            `자동 발송: ${config.enabled ? `평일 ${env.REPORT_TIME_KST}` : '비활성화'}`
          ].join('\n'),
          ephemeral: true
        });
        return;
      }
      case 'report-summary':
      case 'report-full': {
        const detail: ReportDetailLevel = interaction.commandName === 'report-summary' ? 'summary' : 'full';
        await interaction.deferReply({ ephemeral: true });
        try {
          const dispatch = await this.runReport(interaction.guildId, interaction.channelId, 'manual', detail);
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
        const config = await this.reports.ensureGuild(interaction.guildId, interaction.channelId);
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
      default:
        await interaction.reply({ content: '지원하지 않는 명령입니다.', ephemeral: true });
    }
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
        const defaultChannelId = env.DEFAULT_TEXT_CHANNEL_ID ?? this.resolveTextChannelId(guild.id);
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
    const fallbackChannelId = env.DEFAULT_TEXT_CHANNEL_ID ?? this.resolveTextChannelId(guildId);
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
}
