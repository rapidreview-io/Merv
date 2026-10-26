import os
import signal

if not os.environ.get("TRACKIO_WRITE_TOKEN"):
    # Metrics are not configured on this host: stay up and idle, so every release starts the
    # same Compose project whether or not they are.
    print("TRACKIO_WRITE_TOKEN is not set; Trackio stays idle", flush=True)
    signal.pause()

os.environ.setdefault("TRACKIO_COLOR_PALETTE", "#2563eb,#0f766e,#c81e1e,#b45309,#475569,#5f6875")
# Trackio links its logo through /file, which Merv serves only for project media: draw none.
for key in ("TRACKIO_LOGO_LIGHT_URL", "TRACKIO_LOGO_DARK_URL"):
    os.environ.setdefault(key, "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='1'/%3E")

import uvicorn
from trackio.server import build_starlette_app_only

PREFIX = "/trackio"
app, _ = build_starlette_app_only()


async def served(scope, receive, send):
    # Merv forwards /trackio/... unchanged and the dashboard links back under the same prefix;
    # uvicorn's root_path would expect the prefix already stripped.
    if scope["type"] in ("http", "websocket"):
        path = scope["path"]
        if path == PREFIX or path.startswith(PREFIX + "/"):
            path = path[len(PREFIX) :] or "/"
        scope = {**scope, "root_path": PREFIX, "path": path, "raw_path": path.encode()}
    await app(scope, receive, send)


uvicorn.run(
    served,
    host=os.environ.get("TRACKIO_HOST", "0.0.0.0"),
    port=int(os.environ.get("TRACKIO_PORT", "7860")),
)
