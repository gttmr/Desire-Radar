import type { DebatePolicy, ResearchPolicy } from '../config/index.js';
import type { CandidateService } from '../collector/candidate-service.js';
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
    const sourceId = bundle?.evidence_items[0]?.source ?? 'manual_observation';
    const requests = openQuestions
      .slice(0, this.researchPolicy.maxRequestsPerRun)
      .map<ResearchRequest>((question) => ({
        runId: params.runId,
        entity: params.entity,
        requestedByAgent: 'research-loop',
        requestKind: this.researchPolicy.defaultRequestKind,
        targetSourceId: sourceId,
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
    const sourceStatus = await this.candidateService.getSourcesStatus();
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

  private collectOpenQuestions(result: DebatePhaseResult): string[] {
    const questions = result.turns
      .flatMap((turn) => turn.response.open_questions)
      .filter(Boolean);
    return questions.filter((question, index) => questions.indexOf(question) === index);
  }
}
