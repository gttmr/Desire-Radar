import type { AgentExecutionPolicy, ModelProfilesPolicy } from '../config/index.js';
import type { ExecutionPhase, ModelProfile, ResponseFormat } from '../providers/base.js';

export type ResolvedExecutionPolicy = {
  phase: ExecutionPhase;
  modelProfile: ModelProfile;
  providers: string[];
  responseFormat: ResponseFormat;
};

export class ExecutionPolicyResolver {
  constructor(
    private readonly policy: AgentExecutionPolicy,
    private readonly modelProfiles: ModelProfilesPolicy,
    private readonly defaultProviders: string[],
  ) {}

  resolve(agentName: string, fallbackPhase: ExecutionPhase): ResolvedExecutionPolicy {
    const agentPolicy = this.policy.agents[agentName];
    const phase = agentPolicy?.phase ?? fallbackPhase;
    const phasePolicy = this.policy.defaults[phase];

    return {
      phase,
      modelProfile: agentPolicy?.modelProfile ?? phasePolicy.modelProfile,
      providers: this.normalizeProviders(agentPolicy?.providers ?? phasePolicy.providers),
      responseFormat: agentPolicy?.responseFormat ?? phasePolicy.responseFormat,
    };
  }

  resolveModel(provider: string, profile: ModelProfile): string | undefined {
    return this.modelProfiles.providers[provider]?.[profile];
  }

  private normalizeProviders(configured: string[]): string[] {
    const providers = configured.length > 0 ? configured : this.defaultProviders;
    return providers.filter((provider, index) => providers.indexOf(provider) === index);
  }
}
