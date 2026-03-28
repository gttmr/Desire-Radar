from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RawPayload:
    source: str
    data: Any
    request_params: dict
    url_or_ref: str


@dataclass
class ConnectorWarning:
    kind: str
    message: str
    target: str | None = None
    recoverable: bool = True


@dataclass
class FetchResult:
    payloads: list[RawPayload]
    warnings: list[ConnectorWarning] = field(default_factory=list)


class BaseConnector(ABC):
    name: str
    cadence_seconds: int
    source_tier: int  # 1, 2, or 3

    @abstractmethod
    async def fetch(self) -> list[RawPayload] | FetchResult:
        """Fetch data from the source. Returns payloads and optional warnings."""
        ...
