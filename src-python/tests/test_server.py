"""HTTP contract tests: status codes, validation and token handling."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from sunday_solar import server


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # No token configured: local development mode.
    monkeypatch.delenv(server.TOKEN_ENV, raising=False)
    return TestClient(server.app)


def test_health_reports_versions(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["pvlib_version"]
    assert body["engine_version"]
    assert "csp_available" in body
    assert "pysam_version" in body
    assert isinstance(body["csp_available"], bool)
    assert "csp_tower_layout" in body
    assert "csp_tower_plant" in body
    assert "csp_trough_plant" in body


def test_csp_tower_layout_unavailable_is_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sunday_solar.csp import CspUnavailable

    def boom(_body: dict) -> dict:
        raise CspUnavailable("PySAM is not installed.")

    monkeypatch.setattr(server, "run_tower_layout", boom)
    response = client.post(
        "/csp/tower/layout",
        json={
            "latitude": 35.0,
            "longitude": -3.0,
            "h_tower": 150,
            "q_design": 250,
            "helio_width": 12.2,
            "helio_height": 12.2,
            "layout_method": "radial_stagger",
        },
    )
    assert response.status_code == 503
    body = response.json()
    assert "PySAM" in body["detail"]
    assert "nlr-pysam" in body["guidance"]


def test_csp_plant_physics_failure_does_not_tell_you_to_reinstall_pysam(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sunday_solar.csp import CspUnavailable

    def boom(_body: dict) -> dict:
        raise CspUnavailable("Plant returned no usable annual energy (NaN or zero).")

    monkeypatch.setattr(server, "run_tower_plant", boom)
    response = client.post(
        "/csp/tower/plant",
        json={
            "latitude": 35.0,
            "longitude": -3.0,
            "rated_mwe": 115,
            "solar_multiple": 2.4,
            "tes_hours": 10,
            "cooling": "wet",
        },
    )
    assert response.status_code == 503
    body = response.json()
    assert "annual energy" in body["detail"]
    assert "nrel-pysam" not in body["guidance"]
    assert "nlr-pysam" not in body["guidance"]
    assert "Try Estimate again" in body["guidance"]


def test_model_chain_options_preflight(client: TestClient) -> None:
    """Browser POSTs with JSON trigger an OPTIONS preflight first."""
    response = client.options(
        "/model-chain",
        headers={
            "Origin": "http://localhost:1420",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "*"


def test_model_chain_returns_a_method_block(client: TestClient) -> None:
    response = client.post(
        "/model-chain",
        json={
            "site": {"latitude": 35.05, "longitude": -118.17, "timezone": "UTC"},
            "array": {"dc_capacity_kw": 100, "surface_tilt": 25, "surface_azimuth": 180},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["annual_energy_kwh"] > 0
    assert len(body["monthly"]) == 12
    assert body["method"]["dc_model"] == "PVWatts DC"


def test_out_of_range_tilt_is_a_validation_error(client: TestClient) -> None:
    response = client.post(
        "/model-chain",
        json={
            "site": {"latitude": 35.05, "longitude": -118.17},
            "array": {"surface_tilt": 120},
        },
    )
    assert response.status_code == 422


def test_impossible_latitude_is_a_validation_error(client: TestClient) -> None:
    response = client.post(
        "/sun-path", json={"site": {"latitude": 95.0, "longitude": 0.0}}
    )
    assert response.status_code == 422


def test_engine_errors_surface_as_422_with_a_reason(client: TestClient) -> None:
    response = client.post(
        "/transpose",
        json={
            "site": {"latitude": 35.0, "longitude": -118.0},
            "surface_tilt": 25,
            "surface_azimuth": 180,
            "times": ["2023-06-21T12:00:00Z", "2023-06-21T13:00:00Z"],
            "ghi": [900.0],
        },
    )
    assert response.status_code == 422
    assert "same length" in response.json()["detail"]


def test_token_is_required_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(server.TOKEN_ENV, "s3cret")
    importlib.reload(server)
    client = TestClient(server.app)

    payload = {"site": {"latitude": 35.0, "longitude": -118.0}}
    assert client.post("/sun-path", json=payload).status_code == 401

    ok = client.post(
        "/sun-path", json=payload, headers={"Authorization": "Bearer s3cret"}
    )
    assert ok.status_code == 200

    wrong = client.post(
        "/sun-path", json=payload, headers={"Authorization": "Bearer nope"}
    )
    assert wrong.status_code == 401

    # Health stays open so the supervisor can poll it before it has a token.
    assert client.get("/health").status_code == 200

    monkeypatch.delenv(server.TOKEN_ENV, raising=False)
    importlib.reload(server)
