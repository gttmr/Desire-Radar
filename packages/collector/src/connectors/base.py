from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class RawPayload:
    source: str
    data: Any
    request_params: dict
    url_or_ref: str


class BaseConnector(ABC):
    name: str
    cadence_seconds: int
    source_tier: int  # 1, 2, or 3

    @abstractmethod
    async def fetch(self) -> list[RawPayload]:
        """Fetch data from the source. Returns list of raw payloads."""
        ...
