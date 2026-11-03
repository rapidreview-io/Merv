# Browser

A real browser for an agent at a whiteboard: `browser` (`open`, `find`, `act`, `look`, `shot`,
`close`), a thin layer on `playwright-core` over CDP. Dormant, with no tool and no words to the
model, until `MERV_BROWSER_CDP_URL` (with an optional `MERV_BROWSER_CDP_TOKEN`) or
`MERV_BROWSER_RENDER_TOKEN` and `MERV_BROWSER_RENDER_ACCOUNT` (Cloudflare Browser Run) are set.

| Entrypoint            | Requires       | Provides                                   |
| --------------------- | -------------- | ------------------------------------------ |
| `@merv/browser`       | State          | `browser` service                          |
| `@merv/browser/tools` | Browser, Tools | the `browser` tool, where it has a browser |
