import type { Transcript } from '../types/domain.js';

export interface SttProvider {
  transcribePcm16le(audio: Buffer, sampleRate: number): Promise<Transcript>;
  health(): Promise<{ ok: boolean; provider: string }>;
}

export class MockSttProvider implements SttProvider {
  async transcribePcm16le(audio: Buffer, sampleRate: number): Promise<Transcript> {
    const bytesPerSecond = sampleRate * 2;
    const durationMs = Math.max(300, Math.floor((audio.length / bytesPerSecond) * 1000));
    return {
      text: `음성 입력 목업 텍스트 (${Math.round(durationMs / 100) / 10}s)` ,
      confidence: 0.55,
      durationMs
    };
  }

  async health(): Promise<{ ok: boolean; provider: string }> {
    return { ok: true, provider: 'mock' };
  }
}
