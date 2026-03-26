import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { CodexProvider, extractCodexExecResult } from '../src/providers/codex.js';
import {
  ClaudeProvider,
  extractClaudePrintResult,
  parseClaudeAuthStatus,
} from '../src/providers/claude.js';
import {
  GeminiProvider,
  buildGeminiEnv,
  classifyGeminiError,
  extractGeminiPromptResult,
} from '../src/providers/gemini.js';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

function mockExecFile(
  implementation: (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void,
): void {
  execFileMock.mockImplementation((file, args, options, callback) => {
    implementation(file, args, options, callback);
    return {
      stdin: {
        end: vi.fn(),
        write: vi.fn(),
      },
    };
  });
}

describe('provider adapters', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it('extracts codex agent_message and usage from JSONL output', () => {
    const parsed = extractCodexExecResult(`
warn line
{"type":"thread.started","thread_id":"thread-123"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":4}}
`);

    expect(parsed.messageText).toBe('OK');
    expect(parsed.threadId).toBe('thread-123');
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 4,
      uncachedInputTokens: 75,
    });
  });

  it('uses the current codex exec JSON flow instead of deprecated --quiet', async () => {
    mockExecFile((_file, args, _options, callback) => {
      callback(
        null,
        '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
        '',
      );
      expect(args).toEqual([
        'exec',
        '-m',
        'gpt-5.4-mini',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C',
        '/tmp',
        '-s',
        'read-only',
        '--json',
        'Reply with exactly OK',
      ]);
    });

    const provider = new CodexProvider('codex', 30_000);
    const result = await provider.execute({
      prompt: 'Reply with exactly OK',
      phase: 'debate',
      agentName: 'search_intent',
      modelProfile: 'cheap',
      responseFormat: 'text',
      model: 'gpt-5.4-mini',
    });

    expect(result.text).toBe('OK');
    expect(result.sessionId).toBe('thread-1');
  });

  it('uses codex login status for health probing', async () => {
    mockExecFile((_file, args, _options, callback) => {
      expect(args).toEqual(['login', 'status']);
      callback(null, '', 'Logged in using ChatGPT');
    });

    const provider = new CodexProvider('codex', 30_000);
    await expect(provider.probeHealth?.()).resolves.toEqual({ available: true });
  });

  it('parses claude auth status JSON', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({
      available: true,
    });
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"claude.ai"}')).toEqual({
      available: false,
      error: 'Claude auth status reported loggedIn=false (claude.ai)',
    });
  });

  it('uses claude auth status for health probing', async () => {
    mockExecFile((_file, args, _options, callback) => {
      expect(args).toEqual(['auth', 'status']);
      callback(null, '{"loggedIn":true}', '');
    });

    const provider = new ClaudeProvider('claude', 30_000);
    await expect(provider.probeHealth?.()).resolves.toEqual({ available: true });
  });

  it('extracts claude assistant text from stream-json output', () => {
    expect(
      extractClaudePrintResult(
        [
          '{"type":"system","subtype":"init"}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
          '{"type":"result","subtype":"success","is_error":false,"result":""}',
        ].join('\n'),
      ),
    ).toBe('OK');
    expect(
      extractClaudePrintResult(
        '{"type":"result","subtype":"success","is_error":false,"result":"OK"}',
      ),
    ).toBe('OK');
    expect(extractClaudePrintResult('OK')).toBe('OK');
    expect(() =>
      extractClaudePrintResult(
        '{"type":"result","subtype":"success","is_error":true,"result":"rate limited"}',
      ),
    ).toThrow('Claude CLI returned error output: rate limited');
    expect(() =>
      extractClaudePrintResult(
        '{"type":"result","subtype":"success","is_error":false,"result":""}',
      ),
    ).toThrow('Claude CLI returned no assistant message');
  });

  it('uses claude stream-json output and extracts assistant text', async () => {
    mockExecFile((_file, args, _options, callback) => {
      expect(args).toEqual([
        '-p',
        'Reply with exactly OK',
        '--output-format',
        'stream-json',
        '--verbose',
        '--resume',
        'session-123',
      ]);
      callback(
        null,
        [
          '{"type":"system","subtype":"init"}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
          '{"type":"result","subtype":"success","is_error":false,"result":""}',
        ].join('\n'),
        '',
      );
    });

    const provider = new ClaudeProvider('claude', 30_000);
    const result = await provider.execute({
      prompt: 'Reply with exactly OK',
      phase: 'debate',
      agentName: 'search_intent',
      modelProfile: 'cheap',
      responseFormat: 'text',
      sessionId: 'session-123',
    });

    expect(result.text).toBe('OK');
  });

  it('closes claude stdin so headless runs do not hang waiting for piped input', async () => {
    const end = vi.fn();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
          '{"type":"result","subtype":"success","is_error":false,"result":""}',
        ].join('\n'),
        '',
      );
      return {
        stdin: {
          end,
        },
      };
    });

    const provider = new ClaudeProvider('claude', 30_000);
    await provider.execute({
      prompt: 'Reply with exactly OK',
      phase: 'debate',
      agentName: 'search_intent',
      modelProfile: 'cheap',
    });

    expect(end).toHaveBeenCalledTimes(1);
  });

  it('uses claude stdout even when the CLI exits non-zero', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed'), { code: 1 }),
        '{"type":"result","subtype":"success","is_error":true,"result":"rate limited"}',
        '',
      );
      return {
        stdin: {
          end: vi.fn(),
        },
      };
    });

    const provider = new ClaudeProvider('claude', 30_000);
    const result = await provider.execute({
      prompt: 'Reply with exactly OK',
      phase: 'debate',
      agentName: 'search_intent',
      modelProfile: 'cheap',
    });

    expect(result.text).toContain('[claude-mock] Claude CLI returned error output: rate limited');
  });

  it('classifies gemini capacity errors distinctly from auth failures', () => {
    expect(
      classifyGeminiError(
        'status 429 RESOURCE_EXHAUSTED MODEL_CAPACITY_EXHAUSTED for gemini-3.1-pro-preview',
      ),
    ).toBe('Gemini reachable but temporarily unavailable (capacity/rate limit).');
    expect(classifyGeminiError('authentication failed: login expired')).toBe(
      'Gemini authentication failed.',
    );
  });

  it('prepends the gemini executable directory to PATH', () => {
    const env = buildGeminiEnv('/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin/gemini', {
      HOME: '/home/ilmaswsl',
      PATH: '/usr/local/bin:/usr/bin',
    });

    expect(env.PATH).toBe(
      '/home/ilmaswsl/.nvm/versions/node/v24.13.0/bin:/usr/local/bin:/usr/bin',
    );
    expect(env.HOME).toBe('/home/ilmaswsl');
  });

  it('extracts gemini response payload from JSON output', () => {
    expect(extractGeminiPromptResult('{"response":"OK"}')).toBe('OK');
    expect(() => extractGeminiPromptResult('{"response":""}')).toThrow(
      'Gemini CLI returned empty response payload',
    );
  });

  it('surfaces gemini probe failures with classified errors', async () => {
    mockExecFile((_file, args, _options, callback) => {
      expect(args).toEqual(['-p', 'Reply with exactly OK']);
      callback(
        new Error('Command failed'),
        '',
        'status 429 RESOURCE_EXHAUSTED MODEL_CAPACITY_EXHAUSTED',
      );
    });

    const provider = new GeminiProvider('gemini', 30_000);
    await expect(provider.probeHealth?.()).resolves.toEqual({
      available: false,
      error: 'Gemini reachable but temporarily unavailable (capacity/rate limit).',
    });
  });

  it('uses gemini JSON output for execution', async () => {
    mockExecFile((_file, args, _options, callback) => {
      expect(args).toEqual(['-o', 'json', '-p', 'Reply with exactly OK']);
      callback(null, '{"response":"OK"}', '');
    });

    const provider = new GeminiProvider('gemini', 30_000);
    const result = await provider.execute({
      prompt: 'Reply with exactly OK',
      phase: 'debate',
      agentName: 'search_intent',
      modelProfile: 'cheap',
      responseFormat: 'text',
    });

    expect(result.text).toBe('OK');
  });
});
