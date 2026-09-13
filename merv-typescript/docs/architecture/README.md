# Current plugin dependencies

The PNG and SVG are deterministic Graphviz renderings of the `inject` declarations in the current code. `current-dependencies.json` preserves the extracted providers, prerequisites, source paths, and direct consumer counts. The two DOT files retain the exact network edges used for layout. The six adapter rows in the image account for the remaining thirteen dependencies.

The snapshot has twenty plugins: fourteen service providers and six tool adapters, with forty-two direct dependencies. Scope is repeated as a reference in the second panel; it is one shared provider. Arrows mean the source plugin requires the target service, not that requests travel in that direction. Remote service health is handled separately by the integration.

Nisa is implemented but its real-service and Fable review gates remain open. The default configuration has eighteen entries; Mounts and Nisa are explicit additions. The image represents implemented declarations, not a claim that every optional plugin is currently running in one persistent server.

An initial image-generation preview drew incorrect arrows. It was replaced by this rendering from the extracted declarations. Only this corrected PNG was uploaded to Google Drive.
