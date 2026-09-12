"""The DESNZ flat file loader: parsing, selection, and the blank-is-not-zero rule."""

import pytest

from nzcai_mcp.reference import (
    SELECTORS,
    ReferenceDataError,
    available_years,
    load_year,
    parse_flat_file,
    parse_numeric_cell,
    resolve_fuel_factors,
)

from fixtures.desnz import FLAT_FILE, HEADER, write_flat_file


@pytest.fixture
def index(tmp_path):
    write_flat_file(tmp_path)
    return load_year(tmp_path, 2025)


# --- parsing --------------------------------------------------------------


def test_header_found_beneath_the_sheet_title_rows(index):
    assert index.factor_column == "GHG Conversion Factor 2025"
    assert len(index.rows) == 7


@pytest.mark.parametrize("raw,expected", [
    ("0.5", 0.5), ("1,234.5", 1234.5), ("0", 0.0), ("-1.5", -1.5), ("1.2e-3", 0.0012),
    ("", None), ("   ", None), (None, None), ("n/a", None), ("N/A", None), ("-", None),
])
def test_numeric_cell_parsing(raw, expected):
    assert parse_numeric_cell(raw) == expected


def test_blank_factor_is_unavailable_not_zero():
    """DESNZ republished the 2026 file because blanks had been shown as 0."""
    rows = parse_flat_file(FLAT_FILE, 2025, "2025.csv").rows
    blank = next(r for r in rows if r.id == "5001")
    assert blank.factor is None
    assert blank.availability == "unavailable"
    assert blank.factor != 0


def test_published_zero_is_a_genuine_zero():
    text = FLAT_FILE.replace(
        "5001,Scope 1,Fuels,Solid fuels,Unavailable fuel,,,kWh (Gross CV),kg CO2e,,x",
        "5001,Scope 1,Fuels,Solid fuels,Zero fuel,,,kWh (Gross CV),kg CO2e,0,x",
    )
    row = parse_flat_file(text, 2025, "2025.csv").by_id("5001")
    assert row.factor == 0.0
    assert row.availability == "available"


def test_thousands_separator_parsed(index):
    assert index.by_id("6001").factor == 1234.5


def test_extra_lookup_columns_ignored(index):
    assert index.by_id("1001").factor == 9.910


def test_missing_columns_reported():
    text = "ID,Scope,Level 1\n1,Scope 1,Fuels\n"
    with pytest.raises(ReferenceDataError, match="missing columns"):
        parse_flat_file(text, 2025, "2025.csv")


def test_missing_factor_column_reported():
    text = HEADER.replace("GHG Conversion Factor 2025,", "") + "\n"
    with pytest.raises(ReferenceDataError, match="no 'GHG Conversion Factor"):
        parse_flat_file(text, 2025, "2025.csv")


def test_file_without_an_id_header_reported():
    with pytest.raises(ReferenceDataError, match="no header row found"):
        parse_flat_file("some,other,sheet\n1,2,3\n", 2025, "2025.csv")


def test_bom_and_crlf_tolerated(tmp_path):
    write_flat_file(tmp_path, text="﻿" + FLAT_FILE.replace("\n", "\r\n"))
    assert load_year(tmp_path, 2025).by_id("3001").factor == 9.5


# --- selection ------------------------------------------------------------


def test_total_row_preferred_over_per_gas_breakdown(index):
    """Row 1002 is the CO2-only breakdown; the reporting total 1001 must win."""
    assert index.find(SELECTORS["electricity_generated"]).id == "1001"


def test_selector_matching_is_case_and_space_insensitive(tmp_path):
    write_flat_file(tmp_path, text=FLAT_FILE.replace("UK electricity", "uk  ELECTRICITY"))
    assert load_year(tmp_path, 2025).find(SELECTORS["electricity_generated"]).id == "1001"


# --- resolution -----------------------------------------------------------


def test_electricity_sums_generation_and_transmission(index):
    resolved = resolve_fuel_factors(index, ["electricity"])["electricity"]
    assert resolved.value == pytest.approx(9.910 + 9.020)
    assert [r.id for r in resolved.rows] == ["1001", "2001"]


def test_natural_gas_uses_the_gross_cv_row(index):
    resolved = resolve_fuel_factors(index, ["natural_gas"])["natural_gas"]
    assert resolved.value == 9.5
    assert [r.id for r in resolved.rows] == ["3001"]


def test_other_fuels_resolve_by_published_row_id(index):
    resolved = resolve_fuel_factors(index, ["gas_oil"], {"gas_oil": "4001"})["gas_oil"]
    assert resolved.value == 9.7


def test_fuel_without_a_selector_or_row_id_is_refused(index):
    with pytest.raises(ReferenceDataError, match="no published selector for fuel 'gas_oil'"):
        resolve_fuel_factors(index, ["gas_oil"])


def test_unknown_row_id_says_ids_change_between_years(index):
    with pytest.raises(ReferenceDataError, match="ids change between years"):
        resolve_fuel_factors(index, ["gas_oil"], {"gas_oil": "9999"})


def test_unavailable_factor_is_refused_rather_than_zeroed(index):
    with pytest.raises(ReferenceDataError, match="must not be treated as zero"):
        resolve_fuel_factors(index, ["mystery"], {"mystery": "5001"})


# --- files on disk --------------------------------------------------------


def test_missing_year_names_where_to_put_the_file(tmp_path):
    write_flat_file(tmp_path, year=2025)
    with pytest.raises(ReferenceDataError, match=r"No DESNZ 2024 flat file loaded \(loaded: 2025\)"):
        load_year(tmp_path, 2024)


def test_no_files_at_all_reports_none_loaded(tmp_path):
    with pytest.raises(ReferenceDataError, match="loaded: none"):
        load_year(tmp_path, 2025)
    assert available_years(tmp_path) == []


def test_available_years_lists_each_flat_file(tmp_path):
    for year in (2024, 2026, 2025):
        write_flat_file(tmp_path, year=year)
    assert available_years(tmp_path) == [2024, 2025, 2026]


def test_replacing_a_file_is_picked_up_without_a_restart(tmp_path):
    """The cache keys on mtime and size, as the portal's loader does."""
    import os

    write_flat_file(tmp_path)
    assert load_year(tmp_path, 2025).by_id("3001").factor == 9.5

    path = write_flat_file(tmp_path, text=FLAT_FILE.replace("kg CO2e,9.500", "kg CO2e,8.400"))
    os.utime(path, (0, 0))  # force a different mtime rather than racing the clock
    assert load_year(tmp_path, 2025).by_id("3001").factor == 8.4
