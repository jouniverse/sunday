"""Makes `sunday_solar` importable when pytest is invoked from the repo root.

The sidecar is deliberately not pip-installed during development: Rust launches
it from this directory with the interpreter, so tests should resolve it the same
way the app does.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
