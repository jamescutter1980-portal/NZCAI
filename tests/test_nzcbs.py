"""UK NZCBS limit loading and the indicative check."""

import pytest

from nzcai_mcp.tools.nzcbs import check, is_operational_energy_metric
from nzcai_mcp.uk_nzcbs import (
    NzcbsDataError,
    available_versions,
    load_version,
    parse_limits,
)

from fixtures.nzcbs import LIMITS, write_limits


@pytest.fixture
def index(tmp_path):
    write_limits(tmp_path)
    return load_version(tmp_path)


def run_check(index, sector, year, asset_values=None, **kwargs):
    """Selection mirrors the server's wiring, so the pure check stays testable."""
    matched = index.match_sector(sector) if index else None
    for_sector = [r for r in index.rows if r.sector == matched] if (index and matched) else []
    for_year = [r for r in for_sector if r.year is None or r.year == year]
    return check(
        version=index.version if index else None,
        file_name=index.file_name if index else None,
        sector=matched,
        year=year,
        limit_rows=[{"metric": r.metric, "limit_value": r.limit_value, "unit": r.unit,
                     "year": r.year, "notes": r.notes} for r in for_year],
        asset_values=asset_values or {},
        loaded_versions=[index.version] if index else [],
        loaded_sectors=index.sectors if index else [],
        sector_years=[r.year for r in for_sector if r.year is not None],
        reference_dir="/data/reference/uk-nzcbs",
        requested_sector=sector,
        **kwargs,
    )


# --- parsing --------------------------------------------------------------


def test_rows_without_a_sector_or_metric_are_skipped(index):
    assert len(index.rows) == 5
    assert index.sectors == ["Office", "Retail"]
    assert "embodied_upfront" in index.metrics


def test_blank_limit_is_unavailable_not_zero(index):
    row = next(r for r in index.rows if r.metric == "onsite_renewables")
    assert row.limit_value is None
    assert row.availability == "unavailable"


def test_row_without_a_year_applies_to_every_year(index):
    row = next(r for r in index.rows if r.metric == "onsite_renewables")
    assert row.year is None


def test_missing_columns_reported():
    with pytest.raises(NzcbsDataError, match="missing columns"):
        parse_limits("version,sector,limit_value\nv1,Office,1\n", "v1", "v1.csv")


def test_file_without_a_recognisable_header():
    with pytest.raises(NzcbsDataError, match="no header row"):
        parse_limits("a,b,c\n1,2,3\n", "v1", "v1.csv")


def test_no_files_loaded(tmp_path):
    assert load_version(tmp_path) is None
    assert available_versions(tmp_path) == []


def test_newest_version_default(tmp_path):
    for version in ("v1.0", "v1.10", "v1.9"):
        write_limits(tmp_path, version=version)
    assert available_versions(tmp_path)[0] == "v1.10"


# --- sector matching ------------------------------------------------------


def test_exact_sector_match(index):
    assert index.match_sector("Office") == "Office"


def test_partial_sector_match_when_unambiguous(index):
    assert index.match_sector("offi") == "Office"
    assert index.match_sector("Office Building") == "Office"


def test_ambiguous_sector_is_no_match(tmp_path):
    """Two candidates is no match: the portal will not guess which sector applies."""
    text = LIMITS + "\nvTEST,Office Park,operational_energy_eui,2025,150.5,kWh/m2/yr,SYNTHETIC"
    write_limits(tmp_path, text=text)
    assert load_version(tmp_path).match_sector("Office") == "Office"  # exact still wins
    assert load_version(tmp_path).match_sector("Offic") is None       # two partials


# --- the check ------------------------------------------------------------


def test_supplied_value_under_the_limit_passes(index):
    result = run_check(index, "Office", 2025, {"operational_energy_eui": 95.0})
    row = next(r for r in result["rows"] if r["metric"] == "operational_energy_eui")
    assert row["status"] == "pass"
    assert row["gap"] == pytest.approx(95.0 - 111.1)
    assert result["assessable"] is True


def test_supplied_value_over_the_limit_fails(index):
    result = run_check(index, "Office", 2025, {"operational_energy_eui": 130.0})
    row = next(r for r in result["rows"] if r["metric"] == "operational_energy_eui")
    assert row["status"] == "fail"
    assert row["gap"] == pytest.approx(130.0 - 111.1)
    assert "above the limit" in result["summary"]


def test_metric_with_no_limit_is_not_assessable_never_a_pass(index):
    """A blank limit is the Standard setting none, not a limit of zero."""
    result = run_check(index, "Office", 2025, {"onsite_renewables": 0.0})
    row = next(r for r in result["rows"] if r["metric"] == "onsite_renewables")
    assert row["status"] == "not_assessable"
    assert row["gap"] is None
    assert "not a limit of zero" in row["reason"]


def test_metric_with_no_supplied_value_is_not_assessable(index):
    result = run_check(index, "Office", 2025, {"operational_energy_eui": 95.0})
    row = next(r for r in result["rows"] if r["metric"] == "embodied_upfront")
    assert row["status"] == "not_assessable"
    assert "No value was supplied" in row["reason"]
    assert "whole life carbon assessment" in row["reason"]


def test_metric_keys_are_matched_loosely(index):
    result = run_check(index, "Office", 2025, {"Operational Energy EUI": 95.0})
    row = next(r for r in result["rows"] if r["metric"] == "operational_energy_eui")
    assert row["status"] == "pass"


def test_counts_and_disclaimer(index):
    result = run_check(index, "Office", 2025, {"operational_energy_eui": 95.0})
    assert result["counts"] == {"pass": 1, "fail": 0, "not_assessable": 2}
    assert "not a verified NZCBS assessment" in result["disclaimer"]
    assert any("never as a pass" in w for w in result["warnings"])


def test_undated_row_included_for_any_year(index):
    result = run_check(index, "Office", 2030, {"operational_energy_eui": 50.0})
    metrics = {r["metric"] for r in result["rows"]}
    # The 2030 EUI row plus the undated on-site renewables row; not the 2025 rows.
    assert metrics == {"operational_energy_eui", "onsite_renewables"}


def test_no_limit_table_is_reported_not_raised():
    result = check(
        version=None, file_name=None, sector=None, year=2025, limit_rows=[],
        asset_values={}, loaded_versions=[], loaded_sectors=[], sector_years=[],
        reference_dir="/data/reference/uk-nzcbs", requested_sector="Office",
    )
    assert result["assessable"] is False
    assert "no limit table loaded" in result["summary"]
    assert "nothing to check against" in result["reasons"][0]


def test_unknown_sector_is_reported_with_what_is_loaded(index):
    result = run_check(index, "Datacentre", 2025)
    assert result["assessable"] is False
    assert "Sectors loaded: Office, Retail" in result["reasons"][0]


def test_year_with_no_rows_lists_the_years_that_exist(index):
    result = run_check(index, "Retail", 2040)
    assert result["assessable"] is False
    assert "Years in the file for this sector: 2025" in result["reasons"][0]


@pytest.mark.parametrize("metric,expected", [
    ("operational_energy_eui", True), ("EUI", True), ("Operational Energy", True),
    ("energy_use_intensity", True), ("embodied_upfront", False),
    ("onsite_renewables", False), ("refrigerant_leakage", False),
])
def test_operational_energy_metric_detection(metric, expected):
    assert is_operational_energy_metric(metric) is expected
