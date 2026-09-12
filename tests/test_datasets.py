import json
from pathlib import Path

import pytest

from nzcai_mcp.datasets import DatasetError, load_dataset

REPO_DATA = Path(__file__).resolve().parent.parent / "data"


def test_bundled_pathway_loads_and_is_flagged_unverified():
    dataset = load_dataset(REPO_DATA, "pathways", "example-office-eu")
    assert dataset.values["2030"] > 0
    assert dataset.is_verified is False
    assert "warning" in dataset.citation()


def test_verified_dataset_carries_no_warning(tmp_path):
    (tmp_path / "factors").mkdir()
    (tmp_path / "factors" / "real.json").write_text(
        json.dumps(
            {
                "provenance": {"source": "DESNZ 2025", "published": "2025-06-01", "verified": True},
                "values": {"electricity": 0.2},
            }
        )
    )
    citation = load_dataset(tmp_path, "factors", "real").citation()
    assert citation["verified"] is True
    assert "warning" not in citation


@pytest.mark.parametrize("name", ["../secrets", "a/b", "", "UPPER", "x" * 65])
def test_unsafe_dataset_names_rejected(tmp_path, name):
    with pytest.raises(DatasetError, match="invalid dataset name"):
        load_dataset(tmp_path, "factors", name)


def test_missing_dataset_lists_what_is_available(tmp_path):
    (tmp_path / "factors").mkdir()
    (tmp_path / "factors" / "one.json").write_text('{"values": {}}')
    with pytest.raises(DatasetError, match="available: one"):
        load_dataset(tmp_path, "factors", "two")


def test_malformed_json_is_reported(tmp_path):
    (tmp_path / "factors").mkdir()
    (tmp_path / "factors" / "bad.json").write_text("{not json")
    with pytest.raises(DatasetError, match="not valid JSON"):
        load_dataset(tmp_path, "factors", "bad")


def test_dataset_without_values_key_rejected(tmp_path):
    (tmp_path / "factors").mkdir()
    (tmp_path / "factors" / "noval.json").write_text('{"provenance": {}}')
    with pytest.raises(DatasetError, match="'values'"):
        load_dataset(tmp_path, "factors", "noval")
