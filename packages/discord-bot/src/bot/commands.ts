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
    .setDescription('음성 채널 수집 중지'),
  new SlashCommandBuilder()
    .setName('agent-status')
    .setDescription('모든 관찰 에이전트 최신 신호 조회'),
  new SlashCommandBuilder()
    .setName('agent-run')
    .setDescription('관찰 에이전트 즉시 실행 (캐시 갱신)')
    .addStringOption((opt) =>
      opt
        .setName('agent')
        .setDescription('실행할 에이전트 (미지정 시 전체)')
        .addChoices(
          { name: 'macro (거시경제)', value: 'macro' },
          { name: 'semiconductor (반도체)', value: 'semiconductor' },
          { name: 'geopolitical (지정학)', value: 'geopolitical' },
          { name: 'reddit_sentiment (소셜)', value: 'reddit_sentiment' },
          { name: 'tech_buzz (기술트렌드)', value: 'tech_buzz' },
          { name: 'entertainment (엔터)', value: 'entertainment' },
          { name: 'supply_chain (공급망/심리)', value: 'supply_chain' }
        )
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('knowledge-add')
    .setDescription('투자 관점 지식 추가')
    .addStringOption((opt) =>
      opt.setName('content').setDescription('추가할 지식/인사이트').setRequired(true).setMaxLength(500)
    )
    .addStringOption((opt) =>
      opt.setName('tags').setDescription('태그 (쉼표 구분, 예: semiconductor,cycle)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('knowledge-list')
    .setDescription('저장된 투자 지식 목록 확인'),
  new SlashCommandBuilder()
    .setName('knowledge-remove')
    .setDescription('저장된 투자 지식 삭제')
    .addStringOption((opt) =>
      opt.setName('id').setDescription('삭제할 항목 ID').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('radar-status')
    .setDescription('소스 수집 상태 조회'),
  new SlashCommandBuilder()
    .setName('radar-emerging')
    .setDescription('떠오르는 신호 후보 조회'),
  new SlashCommandBuilder()
    .setName('human-queue')
    .setDescription('대기 중인 사람 입력 요청 조회')
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('최대 조회 개수')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    ),
];

export const commandJson = commandBuilders.map((c) => c.toJSON());
