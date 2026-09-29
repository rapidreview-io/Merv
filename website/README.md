# Merv product website

Standalone public marketing site for runmerv.com. React + TypeScript + Vite; deploy `website/` as its own Vercel project using Node 24. The existing product UI and backend are separate.

## Local development

```sh
npm ci
npm run dev
npm run build
```

## Product and design

Audience: ML / AI startups. Positioning: practical recursive self-improvement through reviewed research cycles. Content is grounded in the Merv repository; proprietary technique access is the owner's requested commercial positioning. Example experiments and charts are explicitly illustrative, not customer results. No fabricated customer logos or quantitative performance claims.

Visuals adapt the original RapidReview site's idea → parallel GPU experiments → reviewed findings → next cycle logic (`RR_Site/src/pages/LandingPage.jsx`). The design is original; no third-party component code copied. The install dialog uses Radix UI (the accessible primitive used by shadcn); icons use Lucide. Fonts are self-hosted.

Primary conversion is an email to gural@rapidreview.io to scope a research pilot. Documentation and open-source links point to current Merv resources. No form service, analytics, cookies, or private research data are used.

Deploy runmerv.com as canonical. Redirect runmerv.ai and www variants to it. Keep domain DNS mail records intact.
