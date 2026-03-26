"""Registry for source-specific raw payload normalizers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .evidence_schema import Evidence

NormalizerFn = Callable[[dict[str, Any], str], list[Evidence]]


class NormalizerRegistry:
    def __init__(self) -> None:
        self._normalizers: dict[str, NormalizerFn] = {}

    def register(self, key: str, fn: NormalizerFn) -> NormalizerFn:
        self._normalizers[key] = fn
        return fn

    def get(self, key: str) -> NormalizerFn | None:
        return self._normalizers.get(key)

    def keys(self) -> list[str]:
        return sorted(self._normalizers)

    def normalize(
        self,
        key: str,
        raw_payload: dict[str, Any],
        snapshot_ref: str,
    ) -> list[Evidence]:
        normalizer = self._normalizers.get(key)
        if normalizer is None:
            return []
        return normalizer(raw_payload, snapshot_ref)


DEFAULT_NORMALIZER_REGISTRY = NormalizerRegistry()


def register_normalizer(key: str) -> Callable[[NormalizerFn], NormalizerFn]:
    def decorator(fn: NormalizerFn) -> NormalizerFn:
        return DEFAULT_NORMALIZER_REGISTRY.register(key, fn)

    return decorator
