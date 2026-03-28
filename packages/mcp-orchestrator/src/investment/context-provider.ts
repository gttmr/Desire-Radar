import type {
  GetInvestmentAssetResponse,
  InvestmentIntakeRecord,
} from '@agentic/shared-types';
import { InvestmentMarkdownStore } from './markdown-store.js';

export class InvestmentContextProvider {
  constructor(private readonly store: InvestmentMarkdownStore) {}

  async listRecentNotesForAsset(assetKey: string, limit = 5): Promise<InvestmentIntakeRecord[]> {
    return this.store.listRecentNotesForAsset(assetKey, limit);
  }

  async getAssetDossier(assetKey: string): Promise<GetInvestmentAssetResponse | null> {
    return this.store.getAsset(assetKey);
  }
}
