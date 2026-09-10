"""Container entrypoint: ``python -m nzcai_mcp``."""

from __future__ import annotations

import sys

from .config import load_config
from .server import run


def main() -> int:
    try:
        config = load_config()
    except ValueError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    run(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
