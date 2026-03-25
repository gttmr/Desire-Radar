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

        score = 1.0
        score -= failure_rate * 0.6
        score -= dedupe_ratio * 0.2
        score += (resolve_rate - 0.5) * 0.4
        score = max(0.0, min(1.0, score))

        if failure_rate >= 0.7 or score < 0.25:
            status: ValidityStatus = "blocked"
        elif failure_rate >= 0.4 or score < 0.45:
            status = "degraded"
        elif dedupe_ratio >= 0.5 or score < 0.7:
            status = "noisy"
        else:
            status = "healthy"

        recommended_tier: int | None = None
        reason: str | None = None
        if status in {"blocked", "degraded"} and source.configured_tier < 3:
            recommended_tier = min(3, source.configured_tier + 1)
            reason = f"High failure/noise detected (failure_rate={failure_rate:.2f}, dedupe_ratio={dedupe_ratio:.2f})."
        elif status == "healthy" and score > 0.92 and source.configured_tier > 1:
            recommended_tier = max(1, source.configured_tier - 1)
            reason = f"Strong reliability observed (resolve_rate={resolve_rate:.2f}, failure_rate={failure_rate:.2f})."

        return status, round(score, 3), recommended_tier, reason
