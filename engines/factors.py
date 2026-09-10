"""The emission factor library.

Every number the calculation engines produce is a quantity multiplied by a
row from here, and every figure records which row. The library is loaded
from CSV so a new DESNZ release is a data change, not a code change, and the
version travels with every figure it touches.

Two rules matter more than the rest. A factor is only applied to a quantity in
the unit the factor is stated in, or one the library can convert exactly;
anything else is refused rather than guessed. And rows marked illustrative are
refused by default, so a placeholder cannot reach a client report by accident.

Data files:
    engines/data/desnz_2025.csv            verified rows, UK Government 2025 set
    engines/data/illustrative_factors.csv  placeholders for tests and demos only
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

__all__ = [
    "Factor",
    "FactorLibrary",
    "FactorNotFound",
    "UnitMismatch",
    "IllustrativeFactorRefused",
    "convert_quantity",
    "DATA_DIR",
    "DESNZ_2025",
    "ILLUSTRATIVE",
]

DATA_DIR = Path(__file__).resolve().parent / "data"
DESNZ_2025 = DATA_DIR / "desnz_2025.csv"
ILLUSTRATIVE = DATA_DIR / "illustrative_factors.csv"

#: Confidence values a factor may carry. Anything else in a data file is a
#: loading error, so a typo cannot masquerade as verified.
_CONFIDENCE_LEVELS = frozenset({"verified", "stable", "illustrative"})


class FactorNotFound(KeyError):
    """No row for that key."""


class UnitMismatch(ValueError):
    """The quantity's unit cannot be reconciled with the factor's unit."""


class IllustrativeFactorRefused(PermissionError):
    """A placeholder row was requested without opting in to placeholders."""


@dataclass(frozen=True)
class Factor:
    """One row of the library, with everything a figure needs to cite it."""

    key: str
    label: str
    group: str
    unit: str
    scope: str
    ghg_category: str
    kgco2e_per_unit: float
    basis: str
    gwp_basis: str
    source: str
    version: str
    confidence: str
    notes: str

    @property
    def is_illustrative(self) -> bool:
        return self.confidence == "illustrative"

    def tco2e_for(self, quantity: float, unit: str) -> float:
        """Emissions in tonnes for a quantity, converting the unit if it can be."""
        converted = convert_quantity(quantity, unit, self.unit)
        return converted * self.kgco2e_per_unit / 1000.0


#: Exact conversions only. Each entry is (from, to): multiplier. Anything not
#: listed is a refusal, because a density or an energy content is itself a
#: figure that needs evidence and belongs in the data, not hidden here.
_CONVERSIONS: dict[tuple[str, str], float] = {
    ("kWh", "MWh"): 1e-3,
    ("MWh", "kWh"): 1e3,
    ("kWh", "GWh"): 1e-6,
    ("GWh", "kWh"): 1e6,
    ("MWh", "GWh"): 1e-3,
    ("GWh", "MWh"): 1e3,
    ("kg", "tonne"): 1e-3,
    ("tonne", "kg"): 1e3,
    ("g", "kg"): 1e-3,
    ("kg", "g"): 1e3,
    ("litre", "m3"): 1e-3,
    ("m3", "litre"): 1e3,
    ("km", "m"): 1e3,
    ("m", "km"): 1e-3,
}


def convert_quantity(value: float, from_unit: str, to_unit: str) -> float:
    """Convert between units the library can do exactly, or refuse."""
    if from_unit == to_unit:
        return value
    try:
        return value * _CONVERSIONS[(from_unit, to_unit)]
    except KeyError:
        raise UnitMismatch(
            f"cannot convert {from_unit} to {to_unit}; no exact conversion is "
            "defined and none will be guessed"
        ) from None


class FactorLibrary:
    """A read-only, versioned collection of factors loaded from CSV."""

    def __init__(self, factors: Iterable[Factor], *, allow_illustrative: bool = False):
        self._by_key: dict[str, Factor] = {}
        self._allow_illustrative = allow_illustrative
        for factor in factors:
            if factor.key in self._by_key:
                raise ValueError(f"duplicate factor key {factor.key!r}")
            self._by_key[factor.key] = factor

    @classmethod
    def load(cls, *paths: Path, allow_illustrative: bool = False) -> "FactorLibrary":
        """Load one or more CSV files. Defaults to the verified DESNZ set.

        Pass ``allow_illustrative=True`` to admit placeholder rows. Tests and
        demos do; production callers must not, and the default refuses them.
        """
        if not paths:
            paths = (DESNZ_2025,)
        return cls(_read_rows(paths), allow_illustrative=allow_illustrative)

    def get(self, key: str) -> Factor:
        """Fetch a factor by key, refusing placeholders unless opted in."""
        try:
            factor = self._by_key[key]
        except KeyError:
            raise FactorNotFound(
                f"no factor {key!r} in the library; available keys are "
                f"{sorted(self._by_key)}"
            ) from None
        if factor.is_illustrative and not self._allow_illustrative:
            raise IllustrativeFactorRefused(
                f"factor {key!r} is an illustrative placeholder and this library "
                "was not opened with allow_illustrative=True"
            )
        return factor

    def __contains__(self, key: str) -> bool:
        return key in self._by_key

    def __iter__(self) -> Iterator[Factor]:
        return iter(self._by_key.values())

    def __len__(self) -> int:
        return len(self._by_key)

    def keys(self) -> list[str]:
        return sorted(self._by_key)

    def for_category(self, ghg_category: str) -> list[Factor]:
        """Every factor whose GHG category matches, for example "Category 5"."""
        return [f for f in self if f.ghg_category == ghg_category]

    @property
    def versions(self) -> frozenset[str]:
        """The distinct factor-set versions loaded, for a methodology sheet."""
        return frozenset(f"{f.source} {f.version}" for f in self)


def _read_rows(paths: Iterable[Path]) -> Iterator[Factor]:
    for path in paths:
        with open(path, newline="", encoding="utf-8") as handle:
            for line_no, row in enumerate(csv.DictReader(handle), start=2):
                confidence = row["confidence"].strip()
                if confidence not in _CONFIDENCE_LEVELS:
                    raise ValueError(
                        f"{path.name}:{line_no}: confidence {confidence!r} is not "
                        f"one of {sorted(_CONFIDENCE_LEVELS)}"
                    )
                yield Factor(
                    key=row["activity_key"].strip(),
                    label=row["activity_label"].strip(),
                    group=row["group"].strip(),
                    unit=row["unit"].strip(),
                    scope=row["scope"].strip(),
                    ghg_category=row["ghg_category"].strip(),
                    kgco2e_per_unit=float(row["factor_kgco2e"]),
                    basis=row["basis"].strip(),
                    gwp_basis=row["gwp_basis"].strip(),
                    source=row["source"].strip(),
                    version=str(row["factor_year"]).strip(),
                    confidence=confidence,
                    notes=row.get("notes", "").strip(),
                )
