import type {
  NormalizeInvestmentEquityRequest,
  NormalizeInvestmentEquityResponse,
} from '@agentic/shared-types';
import { EquityIdentityResolver } from './equity-identity.js';

export class InvestmentEquityIdentityService {
  constructor(private readonly resolver: EquityIdentityResolver) {}

  async normalize(
    request: NormalizeInvestmentEquityRequest,
  ): Promise<NormalizeInvestmentEquityResponse> {
    return {
      identity: await this.resolver.normalize(request.input),
    };
  }
}
