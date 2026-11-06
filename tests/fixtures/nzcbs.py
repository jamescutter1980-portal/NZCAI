"""Helpers for the UK NZCBS reference tests.

The real Rev 1 tables are bundled with the repository (reference/uk-nzcbs/v1r1),
so tests read them directly. The one fixture here copies that folder into a
deployment directory and tampers with a limit, to prove the loader refuses a
table that no longer matches its manifest.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from nzcai_mcp.nzcbs import bundled_reference_dir

VECTORS = Path(__file__).resolve().parents[1] / "nzcbs" / "vectors.json"


def tampered_copy(base: Path, version: str = "v9test") -> Path:
    """A deployment copy of the bundled v1r1 folder with one limit changed."""
    src = bundled_reference_dir() / "v1r1"
    dest = base / "uk-nzcbs" / version
    shutil.copytree(src, dest)
    limits = dest / "limits.csv"
    limits.write_text(limits.read_text(encoding="utf-8").replace(",805,", ",999,", 1), encoding="utf-8")
    return dest
