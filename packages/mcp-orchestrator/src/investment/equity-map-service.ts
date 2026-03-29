import type {
  GetInvestmentEquityMapResponse,
  PutInvestmentEquityMapRequest,
  PutInvestmentEquityMapResponse,
} from '@agentic/shared-types';
import { EquityMapStore } from './equity-map.js';

export class InvestmentEquityMapService {
  constructor(private readonly store: EquityMapStore) {}

  async get(): Promise<GetInvestmentEquityMapResponse> {
    return {
      path: this.store.path,
      equities: await this.store.list(),
    };
  }

  async replace(
    request: PutInvestmentEquityMapRequest,
  ): Promise<PutInvestmentEquityMapResponse> {
    const equities = await this.store.replace(request.equities);
    return {
      path: this.store.path,
      equities,
      updated_at: new Date().toISOString(),
    };
  }
}
