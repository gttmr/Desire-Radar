"""Advisory-only source validity scoring."""

from __future__ import annotations

from .models import SourceDefinition, ValidityStatus


class SourceValidityEngine:
    """Computes advisory validity and recommended tier without auto-applying it."""

    def evaluate(self, source: SourceDefinition) -> tuple[ValidityStatus, float, int | None, str | None]:
        metrics = source.metrics
        total_runs = max(1, metrics.runs_total + metrics.submissions_total)
        failure_rate = metrics.failures_total / total_runs
        dedupe_ratio = metrics.deduped_snapshot_total / max(1, metrics.snapshot_total)
        resolve_total = metrics.entity_resolve_success_total + metrics.entity_resolve_miss_total
        resolve_rate = (
            metrics.entity_resolve_success_total / resolve_total
            if resolve_total > 0
            else 1.0
        )
        candidate_adoption_rate = min(
            1.0,
            metrics.analysis_candidates_total / max(1, total_runs),
        )
        analysis_total = (
            metrics.analysis_completed_total + metrics.analysis_needs_review_total
            + metrics.analysis_failed_total
        )
        analysis_completion_rate = (
            metrics.analysis_completed_total / analysis_total
            if analysis_total > 0
            else 0.5
        )
        needs_review_ratio = (
            metrics.analysis_needs_review_total / analysis_total
            if analysis_total > 0
            else 0.0
        )
        research_usefulness_rate = (
            metrics.research_useful_total / metrics.research_fulfillment_total
            if metrics.research_fulfillment_total > 0
            else 0.5
        )
        quality_issue_rate = (
            (metrics.quality_degraded_total + metrics.quality_failed_total)
            / total_runs
        )
        quality_failure_rate = metrics.quality_failed_total / total_runs

        score = 0.2
        score += (1.0 - failure_rate) * 0.22
        score += (1.0 - dedupe_ratio) * 0.1
        score += resolve_rate * 0.16
        score += candidate_adoption_rate * 0.12
        score += analysis_completion_rate * 0.12
        score += research_usefulness_rate * 0.14
        score -= needs_review_ratio * 0.12
        score -= quality_issue_rate * 0.14
        score -= quality_failure_rate * 0.12
        score = max(0.0, min(1.0, score))

        if (
            failure_rate >= 0.7
            or score < 0.25
            or quality_failure_rate >= 0.5
            or (
                metrics.analysis_candidates_total >= 3
                and analysis_completion_rate < 0.2
            )
        ):
            status: ValidityStatus = "blocked"
        elif (
            failure_rate >= 0.4
            or score < 0.45
            or quality_issue_rate >= 0.35
            or (
                metrics.research_fulfillment_total >= 2
                and research_usefulness_rate < 0.35
            )
        ):
            status = "degraded"
        elif dedupe_ratio >= 0.5 or score < 0.7 or needs_review_ratio >= 0.45:
            status = "noisy"
        else:
            status = "healthy"

        recommended_tier: int | None = None
        reason: str | None = None
        if status in {"blocked", "degraded"} and source.configured_tier < 3:
            recommended_tier = min(3, source.configured_tier + 1)
            reason = (
                "High failure/noise or weak downstream usefulness detected "
                f"(failure_rate={failure_rate:.2f}, dedupe_ratio={dedupe_ratio:.2f}, "
                f"analysis_completion_rate={analysis_completion_rate:.2f}, "
                f"research_usefulness_rate={research_usefulness_rate:.2f}, "
                f"quality_issue_rate={quality_issue_rate:.2f})."
            )
        elif status == "healthy" and score > 0.92 and source.configured_tier > 1:
            recommended_tier = max(1, source.configured_tier - 1)
            reason = (
                "Strong reliability and downstream usefulness observed "
                f"(resolve_rate={resolve_rate:.2f}, candidate_adoption_rate={candidate_adoption_rate:.2f}, "
                f"analysis_completion_rate={analysis_completion_rate:.2f})."
            )

        return status, round(score, 3), recommended_tier, reason
