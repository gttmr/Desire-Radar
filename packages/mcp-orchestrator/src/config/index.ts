import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import 'dotenv/config';
import { loadCollectorConfig, type CollectorConfig } from './collector.js';
import {
  loadInvestmentDecisionConfig,
  type InvestmentDecisionConfig,
} from './investment-decision.js';
import {
  loadProviderHealthConfig,
  type ProviderHealthConfig,
} from './provider-health.js';
import { loadProvidersConfig, type ProvidersConfig } from './providers.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modelProfilesSchema = z.object({
  providers: z.record(
    z.object({
      cheap: z.string(),
      balanced: z.string(),
      premium: z.string(),
    }),
  ),
});

const phasePolicySchema = z.object({
  providers: z.array(z.string()).default([]),
  modelProfile: z.enum(['cheap', 'balanced', 'premium']),
  responseFormat: z.enum(['json', 'text']).default('json'),
});

const agentExecutionSchema = z.object({
  defaults: z.object({
    triage: phasePolicySchema,
    debate: phasePolicySchema,
    verdict: phasePolicySchema,
    report: phasePolicySchema,
    investment_decision: phasePolicySchema,
  }),
  agents: z.record(
    z.object({
      phase: z.enum(['triage', 'debate', 'verdict', 'report', 'investment_decision']),
      providers: z.array(z.string()).default([]),
      modelProfile: z.enum(['cheap', 'balanced', 'premium']),
      responseFormat: z.enum(['json', 'text']).default('json'),
    }),
  ),
});

const debatePolicySchema = z.object({
  defaultPlan: z.array(z.string()).default([]),
  maxRounds: z.number().int().positive().default(3),
  consensusRequiresQuietRound: z.boolean().default(true),
  triage: z.object({
    agentName: z.string().default('triage'),
    minimumEmergenceScore: z.number().default(0),
    minimumSourceCount: z.number().int().default(1),
  }),
  verdict: z.object({
    primaryAgent: z.string().default('investment_verdict'),
    crossCheckAgent: z.string().default('synthesis'),
    primaryModelProfile: z.enum(['cheap', 'balanced', 'premium']).default('premium'),
    crossCheckModelProfile: z.enum(['cheap', 'balanced', 'premium']).default('balanced'),
  }),
});

const researchPolicySchema = z.object({
  directAwait: z.boolean().default(true),
  pollIntervalMs: z.number().int().positive().default(2_000),
  timeoutMs: z.number().int().positive().default(20_000),
  maxRequestsPerRun: z.number().int().positive().default(2),
  openQuestionThreshold: z.number().int().nonnegative().default(1),
  defaultRequestKind: z.enum(['run_source', 'submit_agent_evidence', 'request_human_note']).default('run_source'),
  defaultPriority: z.enum(['low', 'normal', 'high']).default('normal'),
});

export type ModelProfilesPolicy = z.infer<typeof modelProfilesSchema>;
export type AgentExecutionPolicy = {
  defaults: Record<
    'triage' | 'debate' | 'verdict' | 'report' | 'investment_decision',
    {
      providers: string[];
      modelProfile: 'cheap' | 'balanced' | 'premium';
      responseFormat: 'json' | 'text';
    }
  >;
  agents: Record<
    string,
    {
      phase: 'triage' | 'debate' | 'verdict' | 'report' | 'investment_decision';
      providers: string[];
      modelProfile: 'cheap' | 'balanced' | 'premium';
      responseFormat: 'json' | 'text';
    }
  >;
};
export type DebatePolicy = {
  defaultPlan: string[];
  maxRounds: number;
  consensusRequiresQuietRound: boolean;
  triage: {
    agentName: string;
    minimumEmergenceScore: number;
    minimumSourceCount: number;
  };
  verdict: {
    primaryAgent: string;
    crossCheckAgent: string;
    primaryModelProfile: 'cheap' | 'balanced' | 'premium';
    crossCheckModelProfile: 'cheap' | 'balanced' | 'premium';
  };
};
export type ResearchPolicy = {
  directAwait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  maxRequestsPerRun: number;
  openQuestionThreshold: number;
  defaultRequestKind: 'run_source' | 'submit_agent_evidence' | 'request_human_note';
  defaultPriority: 'low' | 'normal' | 'high';
};

export type OrchestratorPolicies = {
  modelProfiles: ModelProfilesPolicy;
  agentExecution: AgentExecutionPolicy;
  debate: DebatePolicy;
  research: ResearchPolicy;
  policyDir: string;
};

export type Config = {
  runtime: RuntimeConfig;
  collector: CollectorConfig;
  investmentDecision: InvestmentDecisionConfig;
  providers: ProvidersConfig;
  providerHealth: ProviderHealthConfig;
  policies: OrchestratorPolicies;
};

export function resolvePolicyDir(baseDir: string = __dirname): string {
  const candidates = [
    join(baseDir, '..', '..', 'policy'),
    join(baseDir, '..', '..', '..', 'policy'),
    join(baseDir, '..', '..', '..', '..', 'policy'),
    join(process.cwd(), 'packages', 'mcp-orchestrator', 'policy'),
    join(process.cwd(), 'policy'),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error(`Policy directory not found. Checked: ${candidates.join(', ')}`);
  }
  return matched;
}

function loadJsonFile<T>(policyDir: string, fileName: string, schema: z.ZodSchema<T>): T {
  const filePath = join(policyDir, fileName);
  const raw = readFileSync(filePath, 'utf-8');
  return schema.parse(JSON.parse(raw));
}

export function loadConfig(): Config {
  const policyDir = resolvePolicyDir();
  const runtime = loadRuntimeConfig(process.env);

  return {
    runtime,
    collector: loadCollectorConfig(process.env),
    investmentDecision: loadInvestmentDecisionConfig(process.env, runtime.DATA_DIR),
    providers: loadProvidersConfig(process.env, runtime.DATA_DIR),
    providerHealth: loadProviderHealthConfig(process.env),
    policies: {
      policyDir,
      modelProfiles: loadJsonFile(policyDir, 'model-profiles.json', modelProfilesSchema),
      agentExecution: loadJsonFile(
        policyDir,
        'agent-execution.json',
        agentExecutionSchema,
      ) as AgentExecutionPolicy,
      debate: loadJsonFile(policyDir, 'debate-policy.json', debatePolicySchema) as DebatePolicy,
      research: loadJsonFile(
        policyDir,
        'research-policy.json',
        researchPolicySchema,
      ) as ResearchPolicy,
    },
  };
}
