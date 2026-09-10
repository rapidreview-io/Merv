import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useProjectStore } from '../store/useProjectStore';
import { useBackdrop } from '../store/useBackdrop';
import { reducedMotionQuery } from '../utils/motion';
import { createField } from './field';
import { createRenderer } from './renderer';

// Section of the app = axis pose. Detail pages share their section's tilt so
// every click doesn't nudge the solid — navigation between sections does.
function routeKeyOf(pathname) {
  const parts = pathname.replace(/^\/p\/[^/]+/, '').split('/').filter(Boolean);
  return parts[0] || 'home';
}

// Frame cadence: full 60fps only while the field carries unrest (scroll kick,
// axis re-tilt); the idle spin repaints at ~25fps, invisible through the glass.
const AMBIENT_MS = 40;
const ENERGY_EPS = 1e-6;

/**
 * AppBackdrop — the live desktop backdrop. One fixed canvas behind .shell:
 * the project seeds a slowly tumbling wireframe solid (plus dust), the
 * current section tilts its axis a few degrees, and scrolling pumps angular
 * momentum into the spin. Stops completely when the tab is hidden; fully
 * static under reduced motion; the sidebar toggle unmounts it entirely.
 */
export default function AppBackdrop() {
  const enabled = useBackdrop();
  return enabled ? <BackdropCanvas /> : null;
}

function BackdropCanvas() {
  const canvasRef = useRef(null);
  const stateRef = useRef({});
  const { pathname } = useLocation();
  const projectId = useProjectStore(s => s.projectId);
  const projectKey = projectId || 'global';
  const routeKey = routeKeyOf(pathname);

  // Mount once: renderer + loop + environment listeners.
  useEffect(() => {
    const st = stateRef.current;
    st.renderer = createRenderer(canvasRef.current);
    st.scrollY = window.scrollY;
    st.smoothVel = 0;
    st.raf = 0;
    st.last = 0;
    st.lastPaint = 0;
    const reduced = reducedMotionQuery();

    const view = (still) => {
      const doc = document.scrollingElement;
      const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight);
      return {
        scrollY: st.scrollY,
        // Short pages rest mid-formation; long pages form as you read.
        progress: doc.scrollHeight <= window.innerHeight + 40 ? 0.45 : st.scrollY / scrollable,
        t: performance.now() / 1000,
        still,
      };
    };
    st.paintStill = () => { if (st.field) st.renderer.draw(st.field, view(true)); };

    const tick = (now) => {
      st.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - (st.last || now)) / 1000) || 0.016;
      st.last = now;
      const y = window.scrollY;
      const vel = (y - st.scrollY) / Math.max(dt, 0.001) / window.innerHeight;
      st.scrollY = y;
      st.smoothVel += (vel - st.smoothVel) * Math.min(1, dt * 12);
      const energy = st.field.step(dt, st.smoothVel);
      const active = energy > ENERGY_EPS || Math.abs(st.smoothVel) > 0.01;
      if (!active && now - st.lastPaint < AMBIENT_MS) return; // idle: ~20fps twinkle
      st.lastPaint = now;
      st.renderer.draw(st.field, view(false));
    };

    const start = () => {
      if (st.raf || document.visibilityState === 'hidden') return;
      if (reduced.matches) { st.paintStill(); return; }
      st.last = 0;
      st.raf = requestAnimationFrame(tick);
    };
    const stop = () => { cancelAnimationFrame(st.raf); st.raf = 0; };
    st.restart = () => { stop(); start(); };

    const onResize = () => { st.renderer.resize(); if (reduced.matches) st.paintStill(); };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    const onMotionPref = () => st.restart();
    // Theme lands on <html data-theme>; rebuild glow sprites when it changes.
    const themeWatch = new MutationObserver(() => { st.renderer.setPalette(); if (reduced.matches) st.paintStill(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotionPref);
    st.start = start;
    st.reduced = reduced;
    if (import.meta.env.DEV) {
      // Headless-verification hook: drive frames without rAF/visibility.
      window.__bgDebug = {
        frame: (dt = 0.016, vel = 0) => { const e = st.field.step(dt, vel); st.scrollY = window.scrollY; st.renderer.draw(st.field, view(false)); return e; },
        state: () => ({ solid: st.field.character.solid, accent: st.field.character.accent, edges: st.field.edges.length, dust: st.field.character.dust.length, kick: st.field.kick(), ax: st.field.ax(), ay: st.field.ay(), cx: st.field.cx() }),
      };
    }
    return () => {
      stop();
      themeWatch.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onMotionPref);
    };
  }, []);

  // Project change → new universe; route change → morph the constellation.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.field || st.projectKey !== projectKey) {
      st.projectKey = projectKey;
      st.field = createField(projectKey);
    }
    st.field.setScene(routeKey);
    // Always leave a painted frame (hidden/background tabs get a sky, not a
    // blank, when they surface); the loop takes over from it when motion is on.
    st.paintStill?.();
    if (!st.reduced?.matches) st.start?.();
  }, [projectKey, routeKey]);

  return (
    <div className="app-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="app-bg__canvas" />
    </div>
  );
}
