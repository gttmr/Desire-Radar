import type {
  InvestmentEquityMapEntry,
  NormalizedEquityIdentity,
} from '@agentic/shared-types';
import { EquityMapStore } from './equity-map.js';
import { EquityIdentityCacheStore } from './identity-cache.js';
import { KisInstrumentLookupClient } from './kis-client.js';

function normalizeInput(input: string): string {
  return input.trim();
}

function unresolvedIdentity(input: string): NormalizedEquityIdentity {
  return {
    input,
    resolved: false,
    asset_key: null,
    ticker: null,
    company_name: null,
    market: null,
    exchange: null,
    instrument_code: null,
    aliases: [],
    normalization_source: 'unresolved',
    normalization_confidence: 0,
  };
}

function fromMapEntry(
  input: string,
  entry: InvestmentEquityMapEntry,
  source: NormalizedEquityIdentity['normalization_source'],
): NormalizedEquityIdentity {
  return {
    input,
    resolved: true,
    asset_key: entry.asset_key,
    ticker: entry.ticker,
    company_name: entry.company_name,
    market: entry.market ?? null,
    exchange: entry.exchange ?? null,
    instrument_code: entry.instrument_code ?? null,
    aliases: entry.aliases,
    normalization_source: source,
    normalization_confidence: source === 'equity_map' ? 1 : 0.95,
  };
}

export class EquityIdentityResolver {
  constructor(
    private readonly equityMap: EquityMapStore,
    private readonly identityCache: EquityIdentityCacheStore,
    private readonly kisLookup: KisInstrumentLookupClient,
  ) {}

  async normalize(input: string): Promise<NormalizedEquityIdentity> {
    const normalized = normalizeInput(input);
    if (!normalized) {
      return unresolvedIdentity(input);
    }

    const mapped =
      (await this.equityMap.resolveByTicker(normalized)) ??
      (await this.equityMap.resolveByAlias(normalized));
    if (mapped) {
      return fromMapEntry(normalized, mapped, 'equity_map');
    }

    const cached = await this.identityCache.get(normalized);
    if (cached?.resolved) {
      return {
        ...cached,
        input: normalized,
        normalization_source: 'identity_cache',
      };
    }

    try {
      const lookedUp = await this.kisLookup.lookup(normalized);
      if (lookedUp?.resolved) {
        await this.identityCache.set(normalized, lookedUp);
        return lookedUp;
      }
    } catch {
      return unresolvedIdentity(normalized);
    }

    return unresolvedIdentity(normalized);
  }
}
