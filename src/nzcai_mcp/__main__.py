"""Container entrypoint: ``python -m nzcai_mcp``."""

from __future__ import annotations

import sys

from .config import load_config
from .server import run


def main() -> int:
    # AuthConfigError subclasses ValueError, so a refusal to start unauthenticated
    # exits cleanly with its message rather than a traceback.
    try:
        config = load_config()
        run(config)
    except ValueError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
