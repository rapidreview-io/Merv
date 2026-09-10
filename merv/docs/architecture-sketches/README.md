# Architecture sketches

Zoomed-in, code-grounded views of the current Merv architecture. Each sheet
enlarges one owner, maps its internal flow, and keeps its real project edges
visible around the page.

| Component | Primary concern | Sketch |
|---|---|---|
| Surface | External protocols, identity, scope, contracts, dispatch | [surface.png](surface.png) |
| Application | Cross-module workflow ordering and composed views | [application.png](application.png) |
| Research Core | Research state machines, gates, reviews, atomic commits | [research-core.png](research-core.png) |
| Artifacts | Evidence upload, live slots, figures, immutable sealing | [artifacts.png](artifacts.png) |
| Sandbox | Durable compute lifecycle, observation, quotas, providers | [sandbox.png](sandbox.png) |
| Feed | Editorial posts, media, previews, pagination, advisories | [feed.png](feed.png) |
| Object Storage (historical) | Retired ledger; heavy objects now live in merv-sandboxes behind Infrastructure | [object-storage.png](object-storage.png) |
| Literature | Living review, paper ledger, citations, projections | [literature.png](literature.png) |
| Kernel + Infrastructure | Neutral persistence, events, security, ports, adapters | [kernel-infrastructure.png](kernel-infrastructure.png) |

These are explanatory views, not executable specifications. The corresponding
module guides and source remain authoritative when behavior changes.
