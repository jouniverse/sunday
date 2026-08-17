"""HTTP surface of the solar engine.

Binds to the loopback interface only. When Rust launches it, a per-launch bearer
token is required so that nothing else running on the machine can drive it.
"""

from __future__ import annotations

import asyncio
import os

import pvlib
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import __version__
from .csp import CspUnavailable, probe_pysam, run_tower_layout, run_tower_plant, run_trough_plant
from .engine import (
    EngineError,
    degradation,
    find_optimal_tilt,
    run_model_chain,
    sun_path,
    transpose,
)
from .models import (
    DegradationRequest,
    DegradationResponse,
    ModelChainRequest,
    ModelChainResponse,
    OptimalTiltRequest,
    OptimalTiltResponse,
    SunPathRequest,
    SunPathResponse,
    TransposeRequest,
    TransposeResponse,
)

TOKEN_ENV = "SUNDAY_ENGINE_TOKEN"


def require_token(request: Request) -> None:
    """Rejects requests without the launch token, when one was configured.

    Started by hand for development there is no token and local calls are
    allowed; the socket is still loopback-only either way.
    """
    expected = os.environ.get(TOKEN_ENV)
    if not expected:
        return
    header = request.headers.get("authorization", "")
    presented = header.removeprefix("Bearer ").strip()
    if presented != expected:
        raise HTTPException(status_code=401, detail="invalid or missing engine token")


app = FastAPI(
    title="Sunday solar engine",
    version=__version__,
    summary="pvlib-backed PV modelling for the Sunday desktop app",
)

# Loopback-only server: open CORS so the Vite UI (and Tauri webview) can POST
# JSON without failing the browser OPTIONS preflight with 405.
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.exception_handler(EngineError)
async def engine_error_handler(_request: Request, exc: EngineError) -> JSONResponse:
    # A request pvlib cannot answer is the caller's problem to fix, so it is a
    # 422 with the reason, not a 500.
    return JSONResponse(status_code=422, content={"detail": str(exc)})


def _csp_guidance(detail: str) -> str:
    text = detail.lower()
    if "not installed" in text or "nrel-pysam" in text:
        return (
            "Install the optional sidecar extra: pip install 'nrel-pysam>=5' "
            "(macOS arm64 wheels exist). CSP design still opens; yield stays unavailable until PySAM is present."
        )
    return (
        "The live schematic is still a labelled sketch. Annual energy stays blank until the plant run succeeds. "
        "A native SSC crash is isolated from the HTTP process — the solar engine should stay up. Try Estimate again."
    )


@app.exception_handler(CspUnavailable)
async def csp_unavailable_handler(_request: Request, exc: CspUnavailable) -> JSONResponse:
    detail = str(exc)
    return JSONResponse(
        status_code=503,
        content={"detail": detail, "guidance": _csp_guidance(detail)},
    )


@app.get("/health")
def health() -> dict[str, object]:
    """Liveness plus versions. Rust polls this while starting the sidecar."""
    pysam = probe_pysam()
    return {
        "status": "ok",
        "engine_version": __version__,
        "pvlib_version": pvlib.__version__,
        "pysam_version": pysam.version,
        "csp_available": pysam.available,
        "csp_tower_layout": pysam.tower_layout,
        "csp_tower_plant": pysam.tower_plant,
        "csp_trough_plant": pysam.trough_plant,
    }


@app.post("/model-chain", response_model=ModelChainResponse)
def post_model_chain(
    request: ModelChainRequest, _: None = Depends(require_token)
) -> ModelChainResponse:
    return run_model_chain(request)


@app.post("/optimal-tilt", response_model=OptimalTiltResponse)
def post_optimal_tilt(
    request: OptimalTiltRequest, _: None = Depends(require_token)
) -> OptimalTiltResponse:
    return find_optimal_tilt(request)


@app.post("/sun-path", response_model=SunPathResponse)
def post_sun_path(
    request: SunPathRequest, _: None = Depends(require_token)
) -> SunPathResponse:
    return sun_path(request)


@app.post("/transpose", response_model=TransposeResponse)
def post_transpose(
    request: TransposeRequest, _: None = Depends(require_token)
) -> TransposeResponse:
    return transpose(request)


@app.post("/degradation", response_model=DegradationResponse)
def post_degradation(
    request: DegradationRequest, _: None = Depends(require_token)
) -> DegradationResponse:
    return degradation(request)


@app.post("/csp/tower/layout")
async def post_csp_tower_layout(
    payload: dict = Body(...), _: None = Depends(require_token)
) -> dict:
    # SSC is blocking C++; run off the event loop so /health still answers.
    return await asyncio.to_thread(run_tower_layout, payload)


@app.post("/csp/tower/plant")
async def post_csp_tower_plant(
    payload: dict = Body(...), _: None = Depends(require_token)
) -> dict:
    return await asyncio.to_thread(run_tower_plant, payload)


@app.post("/csp/trough/plant")
async def post_csp_trough_plant(
    payload: dict = Body(...), _: None = Depends(require_token)
) -> dict:
    return await asyncio.to_thread(run_trough_plant, payload)


def main() -> None:
    """Entry point for the packaged sidecar binary."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Sunday solar engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
