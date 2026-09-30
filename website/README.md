# Merv landing page

Public marketing site at runmerv.com. React + TypeScript + Vite, deployed from `website/` as the separate Vercel `runmerv` project. The product UI and backend are separate.

```sh
npm ci
npm run dev
npm run build
```

## Design and behavior

Radix **dark Slate** with white type and rare Blue activity accents. Copy is deliberately sparse: system diagrams and motion carry the story, with workload and provider details available on click. Provider logos are displayed in monochrome. The headline is “Continuous research.” Most connections remain still; a single pulse marks each brief handoff from ideas to experiments, compute provisioning, or retained evidence. A continuous research-system schematic has three layers:

1. New ideas combine research, methods, prior findings and objectives.
2. Two parallel preparation tasks feed three independent experiments. Both tasks gate every experiment. There are no experiment-to-experiment dependencies within the loop. E03 is a successor of a prior-loop hypothesis, not of a current-loop experiment.
3. An illustrative fleet of 24 VM/container workers in six provider pools progresses through provisioning, bootstrap, execution, capture and release. It is not live telemetry. GPU shapes and job names are illustrative, not claims of live deployments or measured performance.

Workload inspection, provider focus, pause, reduced motion, mobile schematics and keyboard navigation are supported. The DAG adapts to a compact mobile layout that keeps both tasks and all three experiments visible together. Mobile compute uses six provider tabs with one four-worker pool visible at a time; desktop retains the complete fleet. Tabs support arrow keys, Home/End, and accessible panel relationships. Background tabs suspend simulation updates. Content is prerendered for crawlers.

The primary CTA emails gural@rapidreview.io about a research pilot. No backend, analytics or tracking service is connected.

## Provider grounding

The 20 cloud adapters and logo assets were checked against the local `merv-sandboxes` repository:

- `control/src/merv_sandboxes/providers/plugins.py`
- `docs/providers/README.md` and individual provider guides
- `ui/public/providers/` (existing vendor logo assets reused unchanged)

Public coverage details distinguish Lambda A10 / Cloudflare live research workflows, DigitalOcean / GiveMeANode CPU transfer checks, and providers/shapes still requiring live validation. Tinker is shown as planned because no implemented integration was found in the inspected repositories. Provider logos identify adapters, not endorsements or partnerships.

## Deployment

Vercel builds with Node 24 and `npm run build`. runmerv.com is canonical; runmerv.ai and both www variants permanently redirect to it. Provider assets, fonts, social image, and favicon are self-hosted. The mail DNS records remain managed by IONOS.
