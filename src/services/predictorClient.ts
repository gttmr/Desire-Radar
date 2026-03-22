import type { PredictorRequest, PredictorResponse } from '../types/domain.js';

export class PredictorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateReport(request: PredictorRequest): Promise<PredictorResponse> {
    const response = await this.fetchImpl(new URL('/reports/generate', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Predictor request failed (${response.status}): ${text}`);
    }

    return (await response.json()) as PredictorResponse;
  }
}
