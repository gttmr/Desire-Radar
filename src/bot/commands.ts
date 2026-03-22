import { ChannelType, SlashCommandBuilder } from 'discord.js';

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('봇 상태 확인'),
  new SlashCommandBuilder()
    .setName('watchlist-add')
    .setDescription('관심 종목 추가')
    .addStringOption((opt) =>
      opt
        .setName('ticker')
        .setDescription('6자리 종목 코드')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(12)
    ),
  new SlashCommandBuilder()
    .setName('watchlist-remove')
    .setDescription('관심 종목 삭제')
    .addStringOption((opt) =>
      opt
        .setName('ticker')
        .setDescription('삭제할 6자리 종목 코드')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(12)
    ),
  new SlashCommandBuilder()
    .setName('watchlist-list')
    .setDescription('관심 종목 목록 확인'),
  new SlashCommandBuilder()
    .setName('report-summary')
    .setDescription('요약 리포트 생성 및 전송'),
  new SlashCommandBuilder()
    .setName('report-full')
    .setDescription('전체 리포트 생성 및 전송'),
  new SlashCommandBuilder()
    .setName('report-status')
    .setDescription('리포트 설정 및 최근 실행 상태 확인'),
  new SlashCommandBuilder()
    .setName('voice-start')
    .setDescription('음성 채널 수집 시작')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('수집할 음성 채널 (미지정 시 내가 접속한 채널)')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('voice-stop')
    .setDescription('음성 채널 수집 중지')
];

export const commandJson = commandBuilders.map((c) => c.toJSON());
