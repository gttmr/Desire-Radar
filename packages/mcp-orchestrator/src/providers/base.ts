export type ModelProfile = 'cheap' | 'balanced' | 'premium';
export type ExecutionPhase = 'triage' | 'debate' | 'verdict' | 'report';
export type ResponseFormat = 'json' | 'text';

export type ProviderExecutionRequest = {
  prompt: string;
  sessionId?: string;
  model?: string;
  modelProfile: ModelProfile;
  phase: ExecutionPhase;
  agentName: string;
  responseFormat?: ResponseFormat;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export interface ProviderAdapter {
  readonly name: string;
  execute(request: ProviderExecutionRequest): Promise<ProviderResult>;
  health(): Promise<boolean>;
}

export type ProviderResult = {
  text: string;
  sessionId: string;
  durationMs: number;
  model?: string;
};
