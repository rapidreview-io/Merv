Board reload integration gate

Run from merv-typescript with a reachable local test Postgres database:

    MERV_TEST_POSTGRES_URL=postgres://127.0.0.1:5432/merv_board_eval node --import tsx --test tests/board.test.ts tests/board-semantic.test.ts tests/board-reload.test.ts

The browser test uses playwright-core's installed Chromium by default. Install it with `npx playwright-core install chromium` in CI, or set MERV_TEST_CHROME to an existing Chrome/Chromium executable. Missing browser is a failure, never a silent skip. macOS example: MERV_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'.

Optional MERV_BOARD_RELOAD_FIXTURE points to a captured board.scene response with body.result.elements. MERV_BOARD_RELOAD_OUTPUT is an absolute output prefix for light/dark PNGs and the restored scene JSON. Fixtures run only against an in-memory API; no production service is contacted or changed.

The gate mounts the actual BoardCanvas and native Excalidraw with delayed local font requests, then checks glyph widths and font readiness, original text, restored synthetic shape containment, cold reload/warm remount, and parent-only plus new-font label-only remote deltas with reciprocal bindings. The server test separately checks save/read retains exact measured dimensions. Semantic geometry and exact-text instructions derive from the evaluated V4; font lifecycle repair and restrained semantic styles are additional release changes covered by these tests.
