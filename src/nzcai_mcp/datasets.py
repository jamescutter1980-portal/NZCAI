"""Loading of versioned reference datasets (emission factors, CRREM pathways).

Every dataset carries its own provenance block, and every tool that consumes one
echoes that provenance back in its result. For audit-grade output the number is
never enough on its own — the caller has to be able to say where it came from.

Datasets live under ``<data_dir>/<kind>/<name>.json`` and are mounted into the
container read-only, so factor tables can be updated without rebuilding the image.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

# Dataset names arrive as tool arguments, so they are matched against this
# rather than joined onto a path directly.
_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class DatasetError(RuntimeError):
    """Raised when a dataset is missing, misnamed or malformed."""


@dataclass(frozen=True)
class Dataset:
    kind: str
    name: str
    provenance: dict[str, Any]
    values: dict[str, Any]

    @property
    def is_verified(self) -> bool:
        return bool(self.provenance.get("verified", False))

    def citation(self) -> dict[str, Any]:
        """The provenance block to attach to any result derived from this dataset."""
        return {
            "dataset": f"{self.kind}/{self.name}",
            "source": self.provenance.get("source", "unknown"),
            "published": self.provenance.get("published"),
            "verified": self.is_verified,
            **(
                {"warning": "UNVERIFIED PLACEHOLDER DATA — not for client issue"}
                if not self.is_verified
                else {}
            ),
        }


def load_dataset(data_dir: Path, kind: str, name: str) -> Dataset:
    if not _SAFE_NAME.match(name):
        raise DatasetError(
            f"invalid dataset name {name!r}: expected lowercase letters, digits, dot, dash or underscore"
        )

    path = data_dir / kind / f"{name}.json"
    if not path.is_file():
        available = ", ".join(list_datasets(data_dir, kind)) or "none"
        raise DatasetError(f"no {kind} dataset named {name!r}; available: {available}")

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DatasetError(f"{path} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict) or "values" not in raw:
        raise DatasetError(f"{path} must be an object with a 'values' key")

    return Dataset(
        kind=kind,
        name=name,
        provenance=raw.get("provenance", {}),
        values=raw["values"],
    )


def list_datasets(data_dir: Path, kind: str) -> list[str]:
    directory = data_dir / kind
    if not directory.is_dir():
        return []
    return sorted(p.stem for p in directory.glob("*.json"))


@lru_cache(maxsize=32)
def _cached(data_dir: Path, kind: str, name: str) -> Dataset:
    return load_dataset(data_dir, kind, name)


def get_dataset(data_dir: Path, kind: str, name: str) -> Dataset:
    """Cached read. Datasets are mounted read-only, so caching is safe for the
    process lifetime; restart the container after updating a factor table."""
    return _cached(data_dir, kind, name)
