export interface CommandSchemaOption {
  name: string;
  type: 'subcommand' | 'subcommand-group';
  options?: CommandSchemaOption[];
}

export interface CommandSchema {
  name: string;
  options?: CommandSchemaOption[];
}

export const commandSchema: CommandSchema[] = [
  {
    name: 'report',
    options: [
      {
        name: 'watchlist',
        type: 'subcommand-group',
        options: [
          { name: 'add', type: 'subcommand' },
          { name: 'remove', type: 'subcommand' },
          { name: 'list', type: 'subcommand' },
        ],
      },
      { name: 'run', type: 'subcommand' },
      { name: 'status', type: 'subcommand' },
    ],
  },
  {
    name: 'radar',
    options: [
      { name: 'sources', type: 'subcommand' },
      { name: 'candidates', type: 'subcommand' },
      { name: 'collect', type: 'subcommand' },
    ],
  },
  {
    name: 'run',
    options: [
      { name: 'start', type: 'subcommand' },
      { name: 'status', type: 'subcommand' },
      { name: 'verdict', type: 'subcommand' },
      { name: 'research', type: 'subcommand' },
      { name: 'requests', type: 'subcommand' },
    ],
  },
  {
    name: 'queue',
    options: [{ name: 'human', type: 'subcommand' }],
  },
  {
    name: 'ops',
    options: [
      { name: 'health', type: 'subcommand' },
      { name: 'providers', type: 'subcommand' },
    ],
  },
];
