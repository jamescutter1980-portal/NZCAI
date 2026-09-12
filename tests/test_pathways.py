"""CRREM pathway loading and the misalignment calculation."""

import pytest

from nzcai_mcp.pathways import (
    PathwayDataError,
    available_versions,
    load_version,
    normalise_scenario,
    parse_pathways,
    require_series,
)
from nzcai_mcp.tools.crrem import CalculationError, misalignment_year

from fixtures.crrem import PATHWAYS, write_pathways


@pytest.fixture
def index(tmp_path):
    write_pathways(tmp_path)
    return load_version(tmp_path)


def series(index, scenario="1.5C", pathway_type="ghg"):
    return [(p.year, p.value) for p in require_series(index, "GB", "Office", pathway_type, scenario)]


# --- parsing --------------------------------------------------------------


def test_only_placeable_rows_are_kept(index):
    """A 3C scenario, an unknown pathway type and a bad year are skipped, not fatal."""
    assert len(index.points) == 10
    assert index.countries == ["GB"]
    assert index.property_types == ["Office", "Retail, High Street"]


@pytest.mark.parametrize("raw,expected", [
    ("1.5C", "1.5C"), ("1.5", "1.5C"), ("1,5C", "1.5C"), ("1.5 °C", "1.5C"), ("1.5degC", "1.5C"),
    ("2C", "2C"), ("2", "2C"), ("2.0C", "2C"), ("2 degC", "2C"),
    ("3C", None), ("", None), ("warm", None),
])
def test_scenario_spellings_the_published_files_use(raw, expected):
    assert normalise_scenario(raw) == expected


def test_quoted_property_type_with_a_comma(index):
    assert any(p.property_type == "Retail, High Street" for p in index.points)


def test_blank_value_is_none_not_zero(index):
    point = next(p for p in index.points if p.year == 2028 and p.scenario == "1.5C")
    assert point.value is None


def test_missing_columns_reported():
    with pytest.raises(PathwayDataError, match="missing columns"):
        parse_pathways("version,property_type\nv1,Office\n", "v1", "v1.csv")


def test_file_without_a_recognisable_header():
    with pytest.raises(PathwayDataError, match="no header row"):
        parse_pathways("a,b,c\n1,2,3\n", "v1", "v1.csv")


# --- version selection ----------------------------------------------------


def test_newest_version_is_the_default(tmp_path):
    for version in ("v2.03", "v2.10", "v2.9"):
        write_pathways(tmp_path, version=version)
    # Numeric-aware ordering: v2.10 is newer than v2.9, not older.
    assert available_versions(tmp_path)[0] == "v2.10"
    assert load_version(tmp_path).version == "v2.10"


def test_unknown_version_lists_what_is_loaded(tmp_path):
    write_pathways(tmp_path)
    with pytest.raises(PathwayDataError, match="not loaded \\(loaded: vTEST\\)"):
        load_version(tmp_path, "v2.04")


def test_no_files_says_where_to_put_one(tmp_path):
    with pytest.raises(PathwayDataError, match="No CRREM pathway files loaded"):
        load_version(tmp_path)
    assert available_versions(tmp_path) == []


def test_unknown_selection_lists_available_coverage(index):
    with pytest.raises(PathwayDataError, match="Loaded property types: Office, Retail, High Street"):
        require_series(index, "GB", "Datacentre", "ghg", "1.5C")


def test_selection_is_case_insensitive(index):
    assert require_series(index, "gb", "office", "ghg", "1.5C")


# --- misalignment ---------------------------------------------------------


def test_single_value_is_held_constant_and_warns(index):
    """The portal's method: a static projection, flagged as such rather than
    dressed up with an assumed rate of improvement."""
    result = misalignment_year(series(index), [(2025, 4.0)])
    assert result["asset_held_constant"] is True
    assert any("static projection" in w for w in result["warnings"])
    # 4.0 stays under 5.555 and 4.444, then exceeds 3.333 in 2027.
    assert result["misalignment_year"] == 2027


def test_projected_series_is_used_as_given(index):
    result = misalignment_year(series(index), [(2025, 5.0), (2026, 4.0), (2027, 3.0)])
    assert result["asset_held_constant"] is False
    assert result["misalignment_year"] is None
    assert result["aligned_over_horizon"] is True


def test_blank_pathway_year_is_skipped_not_treated_as_zero(index):
    """2028 has no published value; a constant asset must not read it as an exceedance."""
    result = misalignment_year(series(index), [(2025, 0.5)])
    row = next(r for r in result["projection"] if r["year"] == 2028)
    assert row["status"] == "no_pathway_value"
    assert row["excess"] is None
    assert result["misalignment_year"] is None
    assert any("carry no value" in w for w in result["warnings"])


def test_asset_years_outside_the_pathway_are_ignored_and_reported(index):
    result = misalignment_year(series(index), [(2025, 1.0), (2099, 99.0)])
    assert any("2099" in w for w in result["warnings"])
    assert all(r["year"] != 2099 for r in result["projection"])


def test_no_overlapping_year_reports_no_result(index):
    result = misalignment_year(series(index), [(2050, 1.0), (2051, 1.0)])
    assert result["misalignment_year"] is None
    assert result["aligned_over_horizon"] is False
    assert "No overlap" in result["detail"]


def test_excess_in_tonnes_when_floor_area_supplied(index):
    result = misalignment_year(series(index), [(2025, 6.555)], floor_area_m2=2_000)
    row = next(r for r in result["projection"] if r["year"] == 2025)
    # 6.555 - 5.555 = 1.0 kgCO2e/m2 over 2,000 m2 = 2 tCO2e
    assert row["excess_tco2e"] == 2.0


def test_basis_warning_always_present(index):
    result = misalignment_year(series(index), [(2025, 1.0)])
    assert any("floor-area basis" in w for w in result["warnings"])


def test_energy_pathway_selectable(index):
    result = misalignment_year(series(index, pathway_type="energy"), [(2025, 200.0)])
    assert result["misalignment_year"] == 2025


def test_empty_asset_series_rejected(index):
    with pytest.raises(CalculationError, match="at least one year"):
        misalignment_year(series(index), [])


def test_negative_asset_value_rejected(index):
    with pytest.raises(CalculationError, match="cannot be negative"):
        misalignment_year(series(index), [(2025, -1.0)])
