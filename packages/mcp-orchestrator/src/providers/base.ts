export interface ProviderAdapter {
  readonly name: string;
  execute(prompt: string, sessionId?: string): Promise<ProviderResult>;
  health(): Promise<boolean>;
}

export type ProviderResult = {
  text: string;
  sessionId: string;
  durationMs: number;
};
