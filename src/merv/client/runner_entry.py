"""Single-file distribution entry point for the machine-local Merv runner."""

from __future__ import annotations

import sys
from collections.abc import Sequence


def main(argv: Sequence[str] | None = None) -> int:
    """Dispatch the standalone archive to its runner or client command."""
    args = list(sys.argv[1:] if argv is None else argv)
    command = args.pop(0) if args and args[0] in {"runner", "client"} else "runner"
    if command == "client":
        from .cli import main as client_main

        return client_main(args)
    from .agent_runner import main as runner_main

    return runner_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
