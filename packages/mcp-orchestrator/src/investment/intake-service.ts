import type {
  GetInvestmentAssetResponse,
  GetInvestmentIntakeResponse,
  InvestmentIntakeRequest,
  InvestmentIntakeResponse,
} from '@agentic/shared-types';
import { InvestmentMarkdownStore } from './markdown-store.js';

export class InvestmentIntakeService {
  constructor(private readonly store: InvestmentMarkdownStore) {}

  async submit(request: InvestmentIntakeRequest): Promise<InvestmentIntakeResponse> {
    const intake = await this.store.createIntake(request);
    const dossiers = await this.store.appendToAssetDossiers(intake);
    return { intake, dossiers };
  }

  async getIntake(intakeId: string): Promise<GetInvestmentIntakeResponse | null> {
    const result = await this.store.getIntake(intakeId);
    if (!result) {
      return null;
    }
    return result;
  }

  async getAsset(assetKey: string): Promise<GetInvestmentAssetResponse | null> {
    const result = await this.store.getAsset(assetKey);
    if (!result) {
      return null;
    }
    return result;
  }
}
