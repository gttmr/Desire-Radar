import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import prism from 'prism-media';

type SpeechHandler = (input: {
  guildId: string;
  channelId: string;
  userId: string;
  pcm16le: Buffer;
  sampleRate: number;
}) => Promise<void>;

export class VoiceCaptureService {
  private readonly connections = new Map<string, VoiceConnection>();
  private readonly targets = new Map<string, { channelId: string; adapterCreator: DiscordGatewayAdapterCreator }>();
  private readonly reconnecting = new Set<string>();

  constructor(private readonly client: Client, private readonly onSpeech: SpeechHandler) {}

  async start(guildId: string, voiceChannelId: string, adapterCreator: DiscordGatewayAdapterCreator): Promise<void> {
    await this.stop(guildId);
    this.targets.set(guildId, { channelId: voiceChannelId, adapterCreator });
    const connection = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1200
        }
      });

      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000
      });

      const chunks: Buffer[] = [];
      decoder.on('data', (chunk: Buffer) => chunks.push(chunk));

      decoder.on('end', () => {
        const pcm = Buffer.concat(chunks);
        if (pcm.length === 0) {
          return;
        }
        void this.onSpeech({
          guildId,
          channelId: voiceChannelId,
          userId,
          pcm16le: pcm,
          sampleRate: 48000
        });
      });

      opusStream.pipe(decoder);
      opusStream.on('error', () => {});
      decoder.on('error', () => {});
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.connections.delete(guildId);
      void this.tryReconnect(guildId);
    });

    this.connections.set(guildId, connection);
  }

  async stop(guildId: string): Promise<void> {
    this.targets.delete(guildId);
    this.reconnecting.delete(guildId);
    const connection = this.connections.get(guildId);
    if (connection) {
      connection.destroy();
      this.connections.delete(guildId);
    }
  }

  isActive(guildId: string): boolean {
    return this.connections.has(guildId);
  }

  activeCount(): number {
    return this.connections.size;
  }

  private async tryReconnect(guildId: string): Promise<void> {
    if (this.reconnecting.has(guildId)) {
      return;
    }
    const target = this.targets.get(guildId);
    if (!target) {
      return;
    }
    this.reconnecting.add(guildId);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await this.start(guildId, target.channelId, target.adapterCreator);
    } catch {
      // Keep mock recovery simple; next disconnection event can retry again.
    } finally {
      this.reconnecting.delete(guildId);
    }
  }
}
