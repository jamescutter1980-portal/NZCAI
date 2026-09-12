import pytest

from nzcai_mcp.tools.carbon import CalculationError, calculate_carbon_intensity

FACTORS = {"electricity": 0.2, "natural_gas": 0.18}


def test_intensity_and_emissions():
    result = calculate_carbon_intensity(
        consumption_kwh={"electricity": 250_000, "natural_gas": 480_000},
        floor_area_m2=5_000,
        factors_kgco2e_per_kwh=FACTORS,
    )
    # 250,000 kWh + 480,000 kWh over 5,000 m2
    assert result["total_consumption_kwh"] == 730_000
    assert result["energy_use_intensity_kwh_per_m2"] == 146.0
    # 250,000 * 0.2 = 50,000 kg; 480,000 * 0.18 = 86,400 kg
    assert result["emissions_by_fuel_kgco2e"] == {"electricity": 50_000.0, "natural_gas": 86_400.0}
    assert result["location_based"]["total_tco2e"] == 136.4
    assert result["location_based"]["carbon_intensity_kgco2e_per_m2"] == 27.28
    assert "market_based" not in result


def test_market_based_only_reprices_electricity():
    result = calculate_carbon_intensity(
        consumption_kwh={"electricity": 250_000, "natural_gas": 480_000},
        floor_area_m2=5_000,
        factors_kgco2e_per_kwh=FACTORS,
        market_based_electricity_factor=0.0,
    )
    assert result["location_based"]["total_tco2e"] == 136.4
    # Gas is untouched: only the 86.4 tCO2e of gas remains.
    assert result["market_based"]["total_tco2e"] == 86.4


def test_zero_floor_area_rejected():
    with pytest.raises(CalculationError, match="floor_area_m2"):
        calculate_carbon_intensity({"electricity": 1.0}, 0, FACTORS)


def test_missing_factor_names_the_fuel():
    with pytest.raises(CalculationError, match="hydrogen"):
        calculate_carbon_intensity({"hydrogen": 1.0}, 100, FACTORS)


def test_negative_consumption_rejected():
    with pytest.raises(CalculationError, match="negative"):
        calculate_carbon_intensity({"electricity": -5.0}, 100, FACTORS)


def test_empty_consumption_rejected():
    with pytest.raises(CalculationError, match="at least one fuel"):
        calculate_carbon_intensity({}, 100, FACTORS)
