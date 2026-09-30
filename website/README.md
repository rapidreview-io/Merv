# Merv product website

Standalone public marketing site for runmerv.com. React + TypeScript + Vite; deploy `website/` as its own Vercel project using Node 24. The existing product UI and backend are separate.

## Local development

```sh
npm ci
npm run dev
npm run build
```

## Product and design

Audience: ML / AI startups. Positioning: practical recursive self-improvement through reviewed research cycles. Content is grounded in the Merv repository; proprietary technique access is the owner's requested commercial positioning. The three-layer workflow illustration is not a live product interface. No fabricated customer logos or quantitative performance claims.

The vertical story follows ideation → agent execution → GPU infrastructure, with connecting paths, an active layer indicator, and portrait diagrams on mobile. Reduced-motion and pause controls stop animation. Visuals adapt the original RapidReview site's idea → parallel GPU experiments → reviewed findings → next cycle logic (`RR_Site/src/pages/LandingPage.jsx`). The design is original; no third-party component code copied. Color tokens come directly from @radix-ui/colors Blue and Slate, with a scoped dark palette for the agent layer. Icons use Lucide. Fonts are self-hosted.

Primary conversion is an email to gural@rapidreview.io to scope a research pilot. Documentation and open-source links point to current Merv resources. No form service, analytics, cookies, or private research data are used.

Deploy runmerv.com as canonical. Redirect runmerv.ai and www variants to it. Keep domain DNS mail records intact.
