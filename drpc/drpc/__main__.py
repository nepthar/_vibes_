"""python -m drpc module:service [address]

Loads a Service object and serves it, e.g.

    python -m drpc examples.todo:svc 127.0.0.1:7700
    python -m drpc examples.todo:svc unix:/tmp/todo.sock
    python -m drpc examples.todo:svc stdio
"""

import importlib
import sys

from .service import Service


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    module_name, _, attr = argv[0].partition(":")
    sys.path.insert(0, ".")
    service = getattr(importlib.import_module(module_name), attr or "svc")
    if not isinstance(service, Service):
        print(f"{argv[0]} is not a drpc.Service", file=sys.stderr)
        return 2
    service.run(argv[1] if len(argv) > 1 else "127.0.0.1:7700")
    return 0



def cli() -> None:
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    cli()
