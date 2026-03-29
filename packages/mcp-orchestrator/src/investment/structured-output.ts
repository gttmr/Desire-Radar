export const STRUCTURED_JSON_OPEN_TAG = '<structured_json>';
export const STRUCTURED_JSON_CLOSE_TAG = '</structured_json>';

export type StructuredJsonParseStrategy =
  | 'tagged'
  | 'fenced'
  | 'exact'
  | 'balanced';

export type StructuredJsonParseResult = {
  parsed: unknown;
  jsonText: string;
  strategy: StructuredJsonParseStrategy;
};

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function extractTaggedJson(text: string): string | null {
  const matcher = new RegExp(
    `${STRUCTURED_JSON_OPEN_TAG}([\\s\\S]*?)${STRUCTURED_JSON_CLOSE_TAG}`,
    'gi',
  );
  let lastMatch: RegExpExecArray | null = null;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    lastMatch = match;
  }
  return lastMatch?.[1]?.trim() ?? null;
}

function extractBalancedJson(text: string): string | null {
  const source = text.trim();
  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') {
      continue;
    }
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) {
        depth += 1;
        continue;
      }
      if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function summarizeParseError(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const snippet = text.trim().slice(0, 300).replace(/\s+/g, ' ');
  if (!snippet) {
    return `${message} (empty provider response)`;
  }
  return `${message} (raw=${snippet})`;
}

function parseCandidate(text: string, strategy: StructuredJsonParseStrategy): StructuredJsonParseResult {
  return {
    parsed: JSON.parse(text),
    jsonText: text,
    strategy,
  };
}

export function parseStructuredJsonText(text: string): StructuredJsonParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Provider returned an empty response');
  }

  const candidates: Array<{ text: string | null; strategy: StructuredJsonParseStrategy }> = [
    { strategy: 'tagged', text: extractTaggedJson(trimmed) },
    { strategy: 'fenced', text: stripMarkdownFences(trimmed) === trimmed ? null : stripMarkdownFences(trimmed) },
    { strategy: 'exact', text: trimmed },
    { strategy: 'balanced', text: extractBalancedJson(trimmed) },
  ];

  let lastError: unknown = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.text?.trim();
    if (!normalized || seen.has(`${candidate.strategy}:${normalized}`)) {
      continue;
    }
    seen.add(`${candidate.strategy}:${normalized}`);
    try {
      return parseCandidate(normalized, candidate.strategy);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(summarizeParseError(lastError, trimmed));
}

export function buildStructuredJsonRetryPrompt(originalPrompt: string): string {
  return [
    originalPrompt,
    '---',
    'Your previous reply was unreadable or invalid JSON.',
    `Reply again with exactly one ${STRUCTURED_JSON_OPEN_TAG}...${STRUCTURED_JSON_CLOSE_TAG} block.`,
    'Inside that block, emit ONLY one valid JSON object.',
    'Do not include markdown fences, prose, bullet points, explanations, or trailing text.',
  ].join('\n\n');
}

export function renderStructuredJsonContract(): string {
  return [
    'Structured output contract:',
    `- Final output must contain exactly one ${STRUCTURED_JSON_OPEN_TAG}...${STRUCTURED_JSON_CLOSE_TAG} block.`,
    '- Inside the block, emit exactly one valid JSON object.',
    '- Do not wrap the JSON in markdown fences.',
    '- Prefer to emit only the tagged block with no extra text.',
    '- If the provider forces visible reasoning, keep the reasoning outside the block and keep the tagged JSON block intact.',
  ].join('\n');
}
