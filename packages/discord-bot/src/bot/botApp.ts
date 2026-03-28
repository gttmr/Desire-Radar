import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from 'discord.js';
import { env } from '../config.js';
import { CollectorClient } from '../services/collectorClient.js';
import { DiscordIngestRouter } from '../services/discordIngestRouter.js';
import { NotificationScheduler } from '../services/notificationScheduler.js';
import { OpsCommandService } from '../services/opsCommandService.js';
import type { OrchestratorClient } from '../services/orchestratorClient.js';
import { ProviderHealthMonitor } from '../services/providerHealthMonitor.js';
import { QueueCommandService } from '../services/queueCommandService.js';
import { RadarCommandService } from '../services/radarCommandService.js';
import { ReportCommandService } from '../services/reportCommandService.js';
import { ReportService, type ReportDispatch } from '../services/reportService.js';
import { RunCommandService } from '../services/runCommandService.js';
import { HumanInputFollowUpService } from '../services/humanInputFollowUpService.js';
import type { ReportDetailLevel, ReportRunMode } from '../types/domain.js';
import { commandJson } from './commands.js';
import {
  detectChannelRoutingWarnings,
  resolveProviderAlertChannelIds,
} from './channelRouting.js';
import { isOpsChannelAllowed, isQueueChannelAllowed } from './commandPolicies.js';

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
  readonly reports: ReportService;
  readonly collector: CollectorClient;
  readonly orchestrator: OrchestratorClient;
  readonly ingestRouter: DiscordIngestRouter;
  readonly providerHealthMonitor?: ProviderHealthMonitor;
  readonly reportCommands: ReportCommandService;
  readonly radarCommands: RadarCommandService;
  readonly runCommands: RunCommandService;
  readonly queueCommands: QueueCommandService;
  readonly opsCommands: OpsCommandService;
  readonly humanInputFollowUps: HumanInputFollowUpService;

  constructor(
    scheduler: NotificationScheduler,
    reports: ReportService,
    collector: CollectorClient,
    orchestrator: OrchestratorClient,
    providerHealthMonitor?: ProviderHealthMonitor,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.scheduler = scheduler;
    this.reports = reports;
    this.collector = collector;
    this.orchestrator = orchestrator;
    this.ingestRouter = new DiscordIngestRouter(collector);
    this.providerHealthMonitor = providerHealthMonitor;
    this.reportCommands = new ReportCommandService(
      reports,
      this.resolveDefaultReportChannelId.bind(this),
      this.runReport.bind(this),
    );
    this.radarCommands = new RadarCommandService(collector);
    this.runCommands = new RunCommandService(orchestrator);
    this.queueCommands = new QueueCommandService(collector);
    this.opsCommands = new OpsCommandService(
      collector,
      orchestrator,
      this.health.bind(this),
    );
    this.humanInputFollowUps = new HumanInputFollowUpService(
      this.reportCommands,
      orchestrator,
    );

    this.client.once(Events.ClientReady, async () => {
      this.logChannelRoutingWarnings();
      await this.registerSlashCommands();
      await this.initializeReportSchedules();
      this.startProviderHealthMonitor();
      console.log(`Logged in as ${this.client.user?.tag}`);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) {
          return;
        }
        await this.handleSlash(interaction);
      } catch (error) {
        console.error('Interaction error', error);
        const message = error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.';
        if (interaction.isRepliable() && interaction.deferred) {
          await interaction.editReply({ content: message });
          return;
        }
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: message, ephemeral: true });
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
    this.client.destroy();
  }

  async health(): Promise<{
    discordReady: boolean;
    activeSchedules: number;
    configuredGuildReports: number;
    providerHealthMonitorRunning: boolean;
  }> {
    const configs = await this.reports.listConfigs();
    return {
      discordReady: this.client.isReady(),
      activeSchedules: this.scheduler.activeSchedules(),
      configuredGuildReports: configs.length,
      providerHealthMonitorRunning: this.providerHealthMonitor?.isRunning() ?? false,
    };
  }

  private async registerSlashCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
    if (env.DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
        body: commandJson,
      });
      return;
    }

    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: commandJson });
  }

  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({ content: '길드에서만 사용할 수 있습니다.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    switch (interaction.commandName) {
      case 'report':
        await this.handleReportSlash(interaction);
        return;
      case 'radar':
        await this.handleRadarSlash(interaction);
        return;
      case 'run':
        await this.handleRunSlash(interaction);
        return;
      case 'queue':
        await this.handleQueueSlash(interaction);
        return;
      case 'ops':
        await this.handleOpsSlash(interaction);
        return;
      default:
        await interaction.editReply({ content: '지원하지 않는 명령입니다.' });
    }
  }

  private async handleReportSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    let content: string;

    if (group === 'watchlist') {
      switch (subcommand) {
        case 'add':
          content = await this.reportCommands.addTicker(
            interaction.guildId!,
            interaction.options.getString('ticker', true),
          );
          break;
        case 'remove':
          content = await this.reportCommands.removeTicker(
            interaction.guildId!,
            interaction.options.getString('ticker', true),
          );
          break;
        case 'list':
          content = await this.reportCommands.listWatchlist(interaction.guildId!);
          break;
        default:
          content = '지원하지 않는 report watchlist 명령입니다.';
      }
      await this.replyWithChunks(interaction, content);
      return;
    }

    switch (subcommand) {
      case 'run': {
        const detail = (interaction.options.getString('detail') ?? 'summary') as ReportDetailLevel;
        content = await this.reportCommands.run(interaction.guildId!, detail);
        break;
      }
      case 'status':
        content = await this.reportCommands.status(interaction.guildId!);
        break;
      default:
        content = '지원하지 않는 report 명령입니다.';
        break;
    }
    await this.replyWithChunks(interaction, content);
  }

  private async handleRadarSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    let content: string;
    switch (subcommand) {
      case 'sources':
        content = await this.radarCommands.sources();
        break;
      case 'candidates':
        content = await this.radarCommands.candidates(interaction.options.getInteger('limit') ?? 15);
        break;
      case 'collect':
        content = await this.radarCommands.collect(interaction.options.getString('source') ?? undefined);
        break;
      default:
        content = '지원하지 않는 radar 명령입니다.';
        break;
    }
    await this.replyWithChunks(interaction, content);
  }

  private async handleRunSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    let content: string;
    switch (subcommand) {
      case 'start':
        content = await this.runCommands.start(interaction.options.getString('entity', true));
        break;
      case 'status':
        content = await this.runCommands.status(interaction.options.getString('run_id', true));
        break;
      case 'verdict':
        content = await this.runCommands.verdict(interaction.options.getString('run_id', true));
        break;
      case 'research':
        content = await this.runCommands.research(interaction.options.getString('run_id', true));
        break;
      case 'requests':
        content = await this.runCommands.requests(interaction.options.getString('run_id', true));
        break;
      default:
        content = '지원하지 않는 run 명령입니다.';
        break;
    }
    await this.replyWithChunks(interaction, content);
  }

  private async handleQueueSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isQueueChannelAllowed(interaction.channelId, env.DISCORD_HUMAN_QUEUE_CHANNEL_IDS)) {
      await interaction.editReply({
        content: '이 명령은 지정된 사람 입력 큐 채널에서만 사용하세요.',
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== 'human') {
      await interaction.editReply({ content: '지원하지 않는 queue 명령입니다.' });
      return;
    }
    const content = await this.queueCommands.human(interaction.options.getInteger('limit') ?? 10);
    await this.replyWithChunks(interaction, content);
  }

  private async handleOpsSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOpsChannelAllowed(interaction.channelId, env.DISCORD_STATUS_CHANNEL_IDS)) {
      await interaction.editReply({
        content: '이 명령은 지정된 상태 채널에서만 사용하세요.',
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const content = subcommand === 'providers'
      ? await this.opsCommands.providers()
      : await this.opsCommands.health();
    await this.replyWithChunks(interaction, content);
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
      if (result.interpretation && result.submissionId) {
        const followUps = await this.humanInputFollowUps.handle({
          guildId: message.guildId,
          channelRef: message.url,
          rawInput: message.content,
          sourceSubmissionId: result.submissionId,
          interpretation: result.interpretation,
        });
        if (followUps.length > 0) {
          await message.reply({
            content: followUps.join('\n').slice(0, 1900),
            allowedMentions: { repliedUser: false },
          });
        }
      }
      return;
    }

    await message.reply({
      content: result.message.slice(0, 1900),
      allowedMentions: { repliedUser: false },
    });
  }

  private async replyWithChunks(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    const chunks = chunkMessage(content, 1_900);
    await interaction.editReply({ content: chunks[0] ?? '(empty)' });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, ephemeral: true });
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
    detail: ReportDetailLevel,
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
