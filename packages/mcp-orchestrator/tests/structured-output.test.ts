import { describe, expect, it } from 'vitest';
import {
  buildStructuredJsonRetryPrompt,
  parseStructuredJsonText,
  STRUCTURED_JSON_CLOSE_TAG,
  STRUCTURED_JSON_OPEN_TAG,
} from '../src/investment/structured-output.js';

describe('structured output parsing', () => {
  it('parses tagged JSON when the model emits reasoning before the result', () => {
    const parsed = parseStructuredJsonText(`
I am compressing the request and preserving coverage gaps.

${STRUCTURED_JSON_OPEN_TAG}
{"executive_summary":"prepared","market_context":"stable"}
${STRUCTURED_JSON_CLOSE_TAG}
`);

    expect(parsed.strategy).toBe('tagged');
    expect(parsed.parsed).toEqual({
      executive_summary: 'prepared',
      market_context: 'stable',
    });
  });

  it('falls back to balanced JSON when no tag is present', () => {
    const parsed = parseStructuredJsonText(
      'Reasoning first. {"summary":"Recovered shortlist","market_view":"Neutral"}',
    );

    expect(parsed.strategy).toBe('balanced');
    expect(parsed.parsed).toEqual({
      summary: 'Recovered shortlist',
      market_view: 'Neutral',
    });
  });

  it('builds a retry prompt that reiterates the tagged JSON contract', () => {
    const retryPrompt = buildStructuredJsonRetryPrompt('original prompt');

    expect(retryPrompt).toContain(STRUCTURED_JSON_OPEN_TAG);
    expect(retryPrompt).toContain(STRUCTURED_JSON_CLOSE_TAG);
    expect(retryPrompt).toContain('valid JSON object');
  });
});
