import pytest

from nzcai_mcp.tools.carbon import CalculationError
from nzcai_mcp.tools.crrem import misalignment_year

PATHWAY = {"2025": 50.0, "2026": 45.0, "2027": 40.0, "2028": 35.0}


def test_asset_already_over_the_pathway_strands_immediately():
    result = misalignment_year(60.0, 2025, PATHWAY)
    assert result["misalignment_year"] == 2025
    assert result["years_to_misalignment"] == 0
    assert result["aligned_over_horizon"] is False


def test_do_nothing_asset_strands_when_the_pathway_drops_past_it():
    result = misalignment_year(42.0, 2025, PATHWAY)
    # 42 sits under 50 and 45, over 40 from 2027.
    assert result["misalignment_year"] == 2027
    assert result["years_to_misalignment"] == 2
    assert [row["aligned"] for row in result["projection"]] == [True, True, False, False]


def test_improvement_rate_can_keep_an_asset_aligned():
    result = misalignment_year(45.0, 2025, PATHWAY, annual_improvement_rate=0.15)
    assert result["misalignment_year"] is None
    assert result["aligned_over_horizon"] is True
    assert result["cumulative_excess_kgco2e_per_m2"] == 0.0


def test_excess_reported_in_tonnes_when_floor_area_supplied():
    result = misalignment_year(60.0, 2025, {"2025": 50.0}, floor_area_m2=2_000)
    # 10 kgCO2e/m2 excess over 2,000 m2 = 20,000 kg = 20 tCO2e
    assert result["projection"][0]["excess_tco2e"] == 20.0
    assert result["cumulative_excess_tco2e"] == 20.0


def test_years_before_the_baseline_are_ignored():
    result = misalignment_year(42.0, 2027, PATHWAY)
    assert [row["year"] for row in result["projection"]] == [2027, 2028]


def test_pathway_ending_before_the_baseline_is_an_error():
    with pytest.raises(CalculationError, match="before the baseline year"):
        misalignment_year(42.0, 2030, PATHWAY)


def test_improvement_rate_out_of_range_rejected():
    with pytest.raises(CalculationError, match="annual_improvement_rate"):
        misalignment_year(42.0, 2025, PATHWAY, annual_improvement_rate=1.5)
