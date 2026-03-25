import type { DebatePolicy, ResearchPolicy } from '../config/index.js';
import type { CandidateService } from '../collector/candidate-service.js';
import type { CollectorSourceStatus } from '../collector/client.js';
import type { ResearchRequest, ResearchService } from '../collector/research-service.js';
import type { SubmissionPoller } from '../collector/submission-poller.js';
import type { DebateService } from './debate.js';
import type { RunContextStore } from '../orchestrator/run-context-store.js';
import type { DebatePhaseResult, ResearchLoopResult } from './types.js';

export class ResearchLoopService {
  constructor(
    private readonly researchService: ResearchService,
    private readonly submissionPoller: SubmissionPoller,
    private readonly candidateService: CandidateService,
    private readonly contextStore: RunContextStore,
    private readonly debateService: DebateService,
    private readonly researchPolicy: ResearchPolicy,
    private readonly debatePolicy: DebatePolicy,
  ) {}

  async run(params: {
    runId: string;
    entity: string;
    latestDebate: DebatePhaseResult;
    providers?: string[];
  }): Promise<ResearchLoopResult> {
    const openQuestions = this.collectOpenQuestions(params.latestDebate);
    if (openQuestions.length < this.researchPolicy.openQuestionThreshold) {
      return { executed: false, results: [], reranDebate: false };
    }

    const bundle = this.contextStore.getBundle(params.runId);
    const sourceCatalog = await this.candidateService.getSourcesCatalog();
    const preferredSourceId = bundle
      ? this.selectPreferredSource(bundle.evidence_items.map((item) => item.source), sourceCatalog)
      : undefined;
    const requests = openQuestions
      .slice(0, this.researchPolicy.maxRequestsPerRun)
      .map<ResearchRequest>((question) => ({
        runId: params.runId,
        entity: params.entity,
        requestedByAgent: 'research-loop',
        requestKind:
          this.researchPolicy.defaultRequestKind === 'run_source' && !preferredSourceId
            ? 'request_human_note'
            : this.researchPolicy.defaultRequestKind,
        targetSourceId: preferredSourceId,
        question,
        whyNow: 'Debate produced unresolved questions that need additional evidence.',
        priority: this.researchPolicy.defaultPriority,
      }));

    const submitted = await Promise.all(
      requests.map(async (request) => {
        const result = await this.researchService.submitRequest(request);
        return this.researchPolicy.directAwait
          ? this.submissionPoller.awaitCompletion(result)
          : result;
      }),
    );

    const results = await Promise.all(submitted);
    this.contextStore.addResearchResults(params.runId, results);

    const completed = results.some((result) => result.status === 'completed');
    if (!completed) {
      return { executed: true, results, reranDebate: false };
    }

    const refreshedBundle = await this.candidateService.buildBundle(params.entity);
    this.contextStore.setBundle(params.runId, refreshedBundle);
    const sourceStatus = await this.candidateService.getSourcesCatalog();
    const rerun = await this.debateService.run({
      runId: params.runId,
      plan: this.debatePolicy.defaultPlan,
      maxRounds: 1,
      providers: params.providers,
      sourceStatus,
      orchestratorQuestions: ['Incorporate the newly collected evidence into your assessment.'],
    });

    return {
      executed: true,
      results,
      reranDebate: true,
      debate: rerun,
    };
  }

  private selectPreferredSource(
    bundleSources: string[],
    sourceCatalog: Record<string, CollectorSourceStatus>,
  ): string | undefined {
    const uniqueSources = bundleSources.filter(
      (source, index, sources) => source && sources.indexOf(source) === index,
    );
    const ranked = uniqueSources
      .map((sourceId) => ({ sourceId, source: sourceCatalog[sourceId] }))
      .filter(
        (
          entry,
        ): entry is { sourceId: string; source: CollectorSourceStatus } =>
          Boolean(entry.source) &&
          entry.source.enabled !== false &&
          entry.source.runnable === true &&
          entry.source.kind !== 'human',
      )
      .sort((left, right) => {
        const kindRank = this.kindPriority(left.source.kind) - this.kindPriority(right.source.kind);
        if (kindRank !== 0) {
          return kindRank;
        }
        const tierRank =
          (left.source.effective_tier ?? left.source.configured_tier ?? left.source.source_tier) -
          (right.source.effective_tier ?? right.source.configured_tier ?? right.source.source_tier);
        if (tierRank !== 0) {
          return tierRank;
        }
        const pendingRank =
          (left.source.pending_submissions ?? 0) - (right.source.pending_submissions ?? 0);
        if (pendingRank !== 0) {
          return pendingRank;
        }
        const failureRank = (left.source.failure_count ?? 0) - (right.source.failure_count ?? 0);
        if (failureRank !== 0) {
          return failureRank;
        }
        return (right.source.last_run ?? '').localeCompare(left.source.last_run ?? '');
      });

    return ranked[0]?.sourceId;
  }

  private kindPriority(kind: CollectorSourceStatus['kind']): number {
    switch (kind) {
      case 'pull':
        return 0;
      case 'agent':
        return 1;
      case 'derived':
        return 2;
      default:
        return 3;
    }
  }

  private collectOpenQuestions(result: DebatePhaseResult): string[] {
    const questions = result.turns
      .flatMap((turn) => turn.response.open_questions)
      .filter(Boolean);
    return questions.filter((question, index) => questions.indexOf(question) === index);
  }
}
