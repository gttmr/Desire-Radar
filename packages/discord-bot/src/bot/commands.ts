import { SlashCommandBuilder } from 'discord.js';

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('관심 종목과 일일 리포트 관리')
    .addSubcommandGroup((group) =>
      group
        .setName('watchlist')
        .setDescription('관심 종목 관리')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('관심 종목 추가')
            .addStringOption((opt) =>
              opt
                .setName('ticker')
                .setDescription('6자리 종목 코드')
                .setRequired(true)
                .setMinLength(6)
                .setMaxLength(12),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('관심 종목 삭제')
            .addStringOption((opt) =>
              opt
                .setName('ticker')
                .setDescription('삭제할 6자리 종목 코드')
                .setRequired(true)
                .setMinLength(6)
                .setMaxLength(12),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('관심 종목 목록 확인'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('일일 리포트 생성 및 전송')
        .addStringOption((opt) =>
          opt
            .setName('detail')
            .setDescription('리포트 상세도')
            .setRequired(false)
            .addChoices(
              { name: 'summary', value: 'summary' },
              { name: 'full', value: 'full' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('리포트 설정 및 최근 실행 상태 확인'),
    ),
  new SlashCommandBuilder()
    .setName('radar')
    .setDescription('collector 수집 상태와 후보 조회')
    .addSubcommand((sub) =>
      sub
        .setName('sources')
        .setDescription('source 상태 조회'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('candidates')
        .setDescription('떠오르는 후보 조회')
        .addIntegerOption((opt) =>
          opt
            .setName('limit')
            .setDescription('최대 조회 개수')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('collect')
        .setDescription('source 수집 트리거')
        .addStringOption((opt) =>
          opt
            .setName('source')
            .setDescription('특정 source id (미지정 시 enabled pull source 전체)')
            .setRequired(false),
        ),
    ),
  new SlashCommandBuilder()
    .setName('run')
    .setDescription('orchestrator run 생성 및 조회')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('candidate entity로 orchestrator run 시작')
        .addStringOption((opt) =>
          opt
            .setName('entity')
            .setDescription('collector candidate entity')
            .setRequired(true)
            .setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('run 상태 조회')
        .addStringOption((opt) =>
          opt
            .setName('run_id')
            .setDescription('조회할 run id')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('verdict')
        .setDescription('run verdict 조회')
        .addStringOption((opt) =>
          opt
            .setName('run_id')
            .setDescription('조회할 run id')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('research')
        .setDescription('run research 결과 조회')
        .addStringOption((opt) =>
          opt
            .setName('run_id')
            .setDescription('조회할 run id')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('requests')
        .setDescription('run research request 목록 조회')
        .addStringOption((opt) =>
          opt
            .setName('run_id')
            .setDescription('조회할 run id')
            .setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('대기 중인 요청 큐 조회')
    .addSubcommand((sub) =>
      sub
        .setName('human')
        .setDescription('대기 중인 사람 입력 요청 조회')
        .addIntegerOption((opt) =>
          opt
            .setName('limit')
            .setDescription('최대 조회 개수')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20),
        ),
    ),
  new SlashCommandBuilder()
    .setName('ops')
    .setDescription('운영 상태 및 provider 상태 조회')
    .addSubcommand((sub) =>
      sub
        .setName('health')
        .setDescription('bot/collector/orchestrator 상태 요약'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('providers')
        .setDescription('provider별 auth/execute 상태 조회'),
    ),
];

export const commandJson = commandBuilders.map((command) => command.toJSON());
