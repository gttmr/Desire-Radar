type CollectorSubmission = {
  submission_id: string;
  status: string;
  evidence_ids?: string[];
  error_message?: string;
};

type CollectorCandidate = {
  entity: string;
  source_count: number;
};

type RunFromCandidateResponse = {
  run_id: string;
  triage: { approved: boolean; reason: string };
  research?: {
    results?: Array<{
      request: {
        intent?: string;
        requestedInputKind?: string;
        requiredFields?: string[];
      };
    }>;
  };
  verdict?: {
    summary: string;
    confidence: number;
    recommendation: string;
    beneficiary_mapping?: {
      public_beneficiaries?: Array<{ name: string }>;
    } | null;
  };
  report?: {
    evaluation?: {
      provider_failures?: Array<{ summary: string }>;
      beneficiary_mapping?: { public_beneficiaries?: Array<{ name: string }> } | null;
    };
  };
};

const COLLECTOR_BASE_URL = process.env.COLLECTOR_BASE_URL ?? 'http://127.0.0.1:5002';
const ORCHESTRATOR_BASE_URL = process.env.ORCHESTRATOR_BASE_URL ?? 'http://127.0.0.1:5003';
const SMOKE_CONNECTOR = process.env.SMOKE_PULL_CONNECTOR ?? 'google_trends';
const SMOKE_ENTITY = process.env.SMOKE_ENTITY ?? 'Cursor';

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForCandidate(entity: string, attempts = 15, intervalMs = 2_000): Promise<CollectorCandidate> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const payload = await request<{ candidates: CollectorCandidate[] }>(
      COLLECTOR_BASE_URL,
      '/candidates/emerging',
    );
    const match = payload.candidates.find(
      (candidate) => candidate.entity.toLowerCase() === entity.toLowerCase(),
    );
    if (match) {
      return match;
    }
    await sleep(intervalMs);
  }
  throw new Error(`candidate not found after polling: ${entity}`);
}

async function pollSubmission(
  submissionId: string,
  attempts = 20,
  intervalMs = 1_500,
): Promise<CollectorSubmission> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const submission = await request<CollectorSubmission>(
      COLLECTOR_BASE_URL,
      `/ingest/submissions/${encodeURIComponent(submissionId)}`,
    );
    if (['completed', 'failed', 'rejected', 'pending_human'].includes(submission.status)) {
      return submission;
    }
    await sleep(intervalMs);
  }
  throw new Error(`submission did not settle: ${submissionId}`);
}

async function loadBundle(
  entity: string,
): Promise<{ evidence: Array<{ source: string; submission_ref?: string }> }> {
  return request(COLLECTOR_BASE_URL, `/evidence/bundles/${encodeURIComponent(entity)}`);
}

async function loadProviderExecutions(
  runId: string,
): Promise<{ executions: Array<{ status: string; degraded_kind?: string | null; error?: string | null }> }> {
  return request(ORCHESTRATOR_BASE_URL, `/runs/${encodeURIComponent(runId)}/provider-executions`);
}

async function main(): Promise<void> {
  const pullSubmission = await request<CollectorSubmission>(
    COLLECTOR_BASE_URL,
    '/collect/run',
    {
      method: 'POST',
      body: JSON.stringify({ connector: SMOKE_CONNECTOR }),
    },
  );

  const humanSubmission = await request<CollectorSubmission>(
    COLLECTOR_BASE_URL,
    '/ingest/human-input',
    {
      method: 'POST',
      body: JSON.stringify({
        content: `title: ${SMOKE_ENTITY} workflow demand spike\nentities: ${SMOKE_ENTITY}\nwhy_now: teams are expanding paid usage this week\nsupporting_points: repeated workflow mentions; seat expansion mentions\n\nDevelopers are increasingly using ${SMOKE_ENTITY} for code review and workflow acceleration.`,
        channel_name: 'smoke-human-input',
        producer_ref: 'end-to-end-smoke',
      }),
    },
  );
  const settledPull = await pollSubmission(pullSubmission.submission_id);
  const settledHuman = await pollSubmission(humanSubmission.submission_id);
  if (settledPull.status !== 'completed') {
    throw new Error(`pull submission did not complete successfully: ${settledPull.status}`);
  }
  if (!['completed', 'pending_human'].includes(settledHuman.status)) {
    throw new Error(`human submission did not settle correctly: ${settledHuman.status}`);
  }

  const candidate = await pollForCandidate(SMOKE_ENTITY);
  const bundle = await loadBundle(candidate.entity);
  const humanEvidenceIncluded = bundle.evidence.some(
    (item) => item.submission_ref === humanSubmission.submission_id,
  );
  if (!humanEvidenceIncluded) {
    throw new Error('bundle missing human-input evidence from this smoke submission');
  }
  const run = await request<RunFromCandidateResponse>(
    ORCHESTRATOR_BASE_URL,
    '/runs/from-candidate',
    {
      method: 'POST',
      body: JSON.stringify({ entity: candidate.entity }),
    },
  );
  const providerExecutions = await loadProviderExecutions(run.run_id);

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        collector: {
          pull_connector: SMOKE_CONNECTOR,
          pull_submission: settledPull,
          human_submission: settledHuman,
          candidate,
          bundle_evidence_count: bundle.evidence.length,
        },
        orchestrator: {
          ...run,
          provider_executions: providerExecutions.executions,
        },
      },
      null,
      2,
    ),
  );

  if (!run.triage.approved) {
    throw new Error(`triage rejected candidate: ${run.triage.reason}`);
  }
  if (!run.verdict) {
    throw new Error('verdict missing from run');
  }
  if (!run.verdict.beneficiary_mapping?.public_beneficiaries?.length) {
    throw new Error('beneficiary mapping missing public beneficiaries');
  }
  if (!run.report?.evaluation?.beneficiary_mapping) {
    throw new Error('report evaluation missing beneficiary mapping scaffold');
  }
  const degradedExecutions = providerExecutions.executions.filter(
    (execution) => execution.status === 'degraded',
  );
  if (degradedExecutions.length > 0 && run.verdict.confidence > 0.58) {
    throw new Error('degraded provider executions were not reflected in verdict confidence');
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[end-to-end-smoke] failed: ${message}`);
  process.exitCode = 1;
});
