export type ModelProfile = 'cheap' | 'balanced' | 'premium';
export type ExecutionPhase = 'triage' | 'debate' | 'verdict' | 'report';
export type ResponseFormat = 'json' | 'text';
export type ProviderTransportMode = 'cli_exec' | 'cli_resume' | 'external_injection';
export type ProviderFailureKind =
  | 'auth_failed'
  | 'binary_missing'
  | 'capacity_limited'
  | 'rate_limited'
  | 'transport_failed'
  | 'timeout'
  | 'parse_failed'
  | 'unknown';
export type ProviderExecutionState = 'completed' | 'degraded';
export type ProviderHealthStatus = 'healthy' | 'unprobed' | ProviderFailureKind;

export type ProviderExecutionRequest = {
  prompt: string;
  sessionId?: string;
  logicalSessionId?: string;
  workingDirectory?: string;
  turnCount?: number;
  transportMode?: ProviderTransportMode;
  transportTarget?: string | null;
  model?: string;
  modelProfile: ModelProfile;
  phase: ExecutionPhase;
  agentName: string;
  responseFormat?: ResponseFormat;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type ProviderHealthProbe = {
  available: boolean;
  status?: ProviderHealthStatus;
  auth_status?: ProviderHealthStatus;
  execute_status?: ProviderHealthStatus;
  transport_status?: ProviderHealthStatus;
  ready_for_execution?: boolean;
  failure_kind?: ProviderFailureKind;
  error_summary?: string;
  error?: string;
  recoverable?: boolean;
};

export interface ProviderAdapter {
  readonly name: string;
  readonly defaultTransportMode?: ProviderTransportMode;
  execute(request: ProviderExecutionRequest): Promise<ProviderResult>;
  health(): Promise<boolean>;
  probeHealth?(): Promise<ProviderHealthProbe>;
}

export type ProviderResult = {
  text: string;
  sessionId: string;
  durationMs: number;
  model?: string;
  status: ProviderExecutionState;
  degraded_kind?: ProviderFailureKind;
  degraded_message?: string;
  recoverable?: boolean;
};
