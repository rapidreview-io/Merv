# Merv landing page

Public marketing site at runmerv.com. React + TypeScript + Vite, deployed from `website/` as the separate Vercel `runmerv` project. The product UI and backend are separate.

```sh
npm ci
npm run dev
npm run build
```

## Design and behavior

Radix **dark Slate** with white type and rare Blue accents for user input and activity. Copy is deliberately sparse: system diagrams and motion carry the story, with workload and provider details available on click. Provider logos retain their original brand colors. A small “Applied AI research” label gives context to the headline “Continuous research.” Most connections remain still; a single pulse marks each brief handoff from ideas to experiments, compute provisioning, or retained evidence. A continuous research-system schematic has three layers:

1. The user’s problem or model sits outside a quiet background field that groups Merv with its provided research and evidence. Only the user input has a caption, “Set by you”; the supplied resource icons sit directly on the horizontal connection axis with labels beneath. “Problem” and “Model” alternate quietly on the simulation clock; pause freezes the label, and reduced motion displays “Problem / Model” without animation. A single downward output leads into the experiment graph, with no duplicate hypothesis row. Desktop and mobile share this structure.
2. T01 has one vertical stem that splits into right-angle branches to E01 and E02. T02 follows a separate elbow connector to E03. Each experiment waits for its own preparation task; E03 combines retained prior-loop data with the new evaluation harness. One collection line gathers the three results for reflection. There are no crossing connectors or experiment-to-experiment dependencies within the loop. Layer navigation and section headings use names without numbering.
3. A single downward connector introduces the illustrative fleet of 24 VM/container workers in six provider pools, progressing through provisioning, bootstrap, execution, capture and release. The output is a steady database visual labeled “Evidence store,” connecting run history and metrics with datasets and checkpoints. It remains visible throughout compute release. It is not live telemetry. GPU shapes and job names are illustrative, not claims of live deployments or measured performance.

The page fills the available width with fluid side gutters. Desktop diagram columns spread as their container grows; a ResizeObserver adjusts SVG geometry while capping the uniform scale at 1.2, so circles stay round and diagrams do not become taller on ultrawide displays. Workload inspection, provider focus, pause, reduced motion, mobile schematics and keyboard navigation are supported. The DAG adapts to a compact mobile layout that keeps both tasks and all three experiments visible together. Mobile compute uses six provider tabs with one four-worker pool visible at a time; desktop retains the complete fleet. Tabs support arrow keys, Home/End, and accessible panel relationships. Background tabs suspend simulation updates. Content is prerendered for crawlers.

The primary CTA emails gural@rapidreview.io about a research pilot. No backend, analytics or tracking service is connected.

## Provider grounding

The 20 cloud adapters and logo assets were checked against the local `merv-sandboxes` repository:

- `control/src/merv_sandboxes/providers/plugins.py`
- `docs/providers/README.md` and individual provider guides
- `ui/public/providers/` (existing vendor logo assets reused unchanged)

Public coverage details distinguish Lambda A10 / Cloudflare live research workflows, DigitalOcean / GiveMeANode CPU transfer checks, and providers/shapes still requiring live validation. Tinker is shown as planned because no implemented integration was found in the inspected repositories. Provider logos identify adapters, not endorsements or partnerships.

## Deployment

Vercel builds with Node 24 and `npm run build`. runmerv.com is canonical; runmerv.ai and both www variants permanently redirect to it. Provider assets, fonts, social image, and favicon are self-hosted. The mail DNS records remain managed by IONOS.
