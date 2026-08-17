"""CSP weather CSV contract — no PySAM required.

SSC's tower/trough readers map irradiance by NSRDB column order and refuse
hours outside 0–23. A short GHI,DNI,DHI table is what produced `hour: 25`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sunday_solar.csp import _compute_lcoe, write_clearsky_weather_csv


def test_clearsky_csv_is_nsrdb_shaped_with_hours_0_to_23(tmp_path: Path) -> None:
    path = tmp_path / "weather.csv"
    write_clearsky_weather_csv(35.0, -3.0, str(path))
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("Source,Location ID,City,State,Country,Latitude")
    assert lines[1].startswith("NSRDB,")
    assert "DHI,DNI,GHI" in lines[2]
    assert "Dew Point" in lines[2]
    assert "Wind Direction" in lines[2]
    assert "Surface Albedo" in lines[2]
    data = lines[3:]
    assert len(data) == 8760
    hours = [int(row.split(",")[3]) for row in data]
    assert min(hours) == 0
    assert max(hours) == 23
    minutes = {row.split(",")[4] for row in data}
    assert minutes == {"0"}
    loc_row = lines[1].split(",")
    assert loc_row[7] == "0"


def test_far_east_csv_time_zone_matches_longitude(tmp_path: Path) -> None:
    path = tmp_path / "alice.csv"
    write_clearsky_weather_csv(-23.5, 133.0, str(path))
    loc_row = path.read_text(encoding="utf-8").splitlines()[1].split(",")
    assert loc_row[6] == "133.0"
    assert loc_row[7] == "9"
    hours = [int(row.split(",")[3]) for row in path.read_text(encoding="utf-8").splitlines()[3:]]
    assert min(hours) == 0
    assert max(hours) == 23


def test_lcoefcr_returns_positive_usd_per_kwh() -> None:
    pytest.importorskip("PySAM.Lcoefcr")
    lcoe, method = _compute_lcoe("tower", 500_000_000.0, 100.0, 400_000_000.0, "test")
    assert lcoe is not None
    assert lcoe > 0
    assert "PySAM.Lcoefcr" in method
    assert "USD" in method
