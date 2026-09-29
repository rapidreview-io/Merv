import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Play,
  Pause,
  Cpu,
  GitBranch,
  Check,
  Plus,
  Minus,
  X,
  Menu,
  ExternalLink,
  Copy,
  CheckCheck,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";

const CONTACT =
  "mailto:gural@rapidreview.io?subject=Run%20Merv%20%E2%80%94%20research%20pilot";
const runs = [
  {
    id: "EXP.042",
    name: "Learn without forgetting.",
    short: "Continual adaptation",
    idea: "Can selective replay preserve earlier capabilities while adapting to new data?",
    method:
      "Compare selective replay with a fine-tuning baseline. Hold the evaluation set fixed and measure both adaptation and retention.",
    hardware: "1 × NVIDIA H100 · 80 GB",
    runtime: "PyTorch · isolated GPU sandbox",
    review: "Check data separation and retention metrics before execution.",
    output: "Retention report + reproducible checkpoint",
    lines: [
      "load baseline + held-out evaluation",
      "sample replay buffer by uncertainty",
      "train adapter · evaluate old + new tasks",
      "submit checkpoint and retention curves",
    ],
    points:
      "0,66 18,59 35,64 53,42 70,46 89,28 107,34 125,21 143,25 162,12 180,15 200,7",
  },
  {
    id: "EXP.043",
    name: "Make every token count.",
    short: "Inference efficiency",
    idea: "Can speculative decoding reduce latency without changing output quality?",
    method:
      "Benchmark a draft model against the existing serving path. Compare acceptance rate, throughput, and tail latency on the same requests.",
    hardware: "2 × NVIDIA A100 · 80 GB",
    runtime: "vLLM · isolated GPU sandbox",
    review: "Check workload equivalence and include warm-up costs.",
    output: "Latency profile + benchmark artifacts",
    lines: [
      "pin request set and model revisions",
      "warm up baseline + draft model",
      "measure p50 / p95 · verify outputs",
      "submit traces and benchmark report",
    ],
    points:
      "0,62 18,60 35,50 53,53 70,36 89,40 107,28 125,31 143,21 162,24 180,10 200,8",
  },
  {
    id: "EXP.044",
    name: "Teach the reasoning, too.",
    short: "Model distillation",
    idea: "Can a smaller model learn from verified reasoning traces instead of answers alone?",
    method:
      "Filter teacher traces with a verifier, train a student, and compare against answer-only supervision on a held-out task set.",
    hardware: "1 × NVIDIA H100 · 80 GB",
    runtime: "PyTorch · isolated GPU sandbox",
    review: "Audit trace quality, evaluation contamination, and the baseline.",
    output: "Student checkpoint + ablation study",
    lines: [
      "filter teacher traces · record provenance",
      "train student with verified rationales",
      "run answer-only ablation · 3 seeds",
      "submit weights and evaluation artifacts",
    ],
    points:
      "0,70 18,65 35,60 53,62 70,42 89,46 107,32 125,28 143,32 162,19 180,21 200,12",
  },
];
const stages = ["Discover", "Design", "Execute", "Review", "Improve"];
function Mark() {
  return (
    <svg viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path
        d="M3 23V7h5l7 9 7-9h5v16h-5V15l-7 9-7-9v8H3Z"
        fill="currentColor"
      />
    </svg>
  );
}
function Field({ paused }: { paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    let w = 0,
      h = 0;
    let t = 0;
    let visible = true;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const size = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      const d = Math.min(devicePixelRatio, 2);
      canvas.width = w * d;
      canvas.height = h * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const cols = 48,
        rows = 22;
      const project = (i: number, j: number) => {
        const z = j / rows;
        return {
          x: w / 2 + (i - cols / 2) * (w / cols) * (0.25 + z * 1.4),
          y:
            h * 0.15 +
            Math.pow(z, 1.65) * h * 0.9 +
            Math.sin(i * 0.31 + t * 0.0002 + j * 0.24) * 10,
        };
      };
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const a = project(i, j),
            b = project(i + 1, j),
            c = project(i, j + 1);
          ctx.strokeStyle = `rgba(128,192,150,${0.025 + (j / rows) * 0.09})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
          ctx.stroke();
          if ((i * 17 + j * 13) % 19 === 0) {
            const pulse = (Math.sin(t * 0.0015 + i + j) + 1) / 2;
            ctx.fillStyle = `rgba(186,255,146,${0.12 + pulse * 0.6})`;
            ctx.fillRect(a.x - 1, a.y - 1, 2, 2);
          }
        }
      for (let i = 0; i < 11; i++) {
        const x = (i * 0.087 + 0.04) * w;
        const y = ((t * 0.012 + i * 93) % (h + 180)) - 90;
        ctx.fillStyle = "rgba(143,206,164,.12)";
        ctx.font = "10px monospace";
        for (let j = 0; j < 6; j++)
          ctx.fillText(
            ((i * 31 + j * 7) % 256).toString(16).padStart(2, "0"),
            x,
            y + j * 16,
          );
      }
    };
    const tick = () => {
      if (visible && !paused && !reduced.matches && !document.hidden) {
        t += 16;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    size();
    draw();
    frame = requestAnimationFrame(tick);
    const resize = new ResizeObserver(() => {
      size();
      draw();
    });
    resize.observe(canvas);
    const observer = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
    });
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
    };
  }, [paused]);
  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
function App() {
  const [selected, setSelected] = useState(0),
    [stage, setStage] = useState(2),
    [paused, setPaused] = useState(
      () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [mobile, setMobile] = useState(false),
    [copied, setCopied] = useState(false);
  const run = runs[selected];
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => setStage((s) => (s + 1) % 5), 3400);
    return () => clearInterval(interval);
  }, [paused]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        "codex plugin marketplace add rapidreview-io/Merv\ncodex plugin add merv@rapidreview\ncodex mcp login merv",
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <a href="#" className="brand" aria-label="Merv home">
          <Mark />
          merv
        </a>
        <nav aria-label="Main navigation" className={mobile ? "open" : ""}>
          <a href="#how-it-works" onClick={() => setMobile(false)}>
            The loop
          </a>
          <a href="#research" onClick={() => setMobile(false)}>
            Research advantage
          </a>
          <a href="https://rapidreview.io/docs/merv">
            Docs <ArrowUpRight size={12} />
          </a>
        </nav>
        <a className="nav-cta" href={CONTACT}>
          Talk to us <ArrowUpRight size={14} />
        </a>
        <button
          className="menu"
          aria-label={mobile ? "Close navigation" : "Open navigation"}
          aria-expanded={mobile}
          onClick={() => setMobile(!mobile)}
        >
          {mobile ? <X /> : <Menu />}
        </button>
      </header>
      <main id="main">
        <section className={"hero " + (paused ? "paused" : "")}>
          <Field paused={paused} />
          <div className="hero-glow" />
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="status-dot" /> RECURSIVE SELF-IMPROVEMENT,
              APPLIED.
            </div>
            <h1>
              Research that
              <br />
              improves <span>itself.</span>
            </h1>
            <p>
              Your models can get better. So can the way you build them.
              <br className="desktop" /> Merv turns ideas into experiments,
              evidence into improvements,
              <br className="desktop" /> and every result into a smarter next
              move.
            </p>
            <div className="hero-actions">
              <a className="button primary" href={CONTACT}>
                Run Merv with your team <ArrowUpRight size={17} />
              </a>
              <a className="text-link" href="#how-it-works">
                <Play size={13} fill="currentColor" /> See the research loop
              </a>
            </div>
            <div className="hero-caption">
              BUILT FOR ML & AI TEAMS WITH SOMETHING TO PROVE.
            </div>
          </div>
          <div className="observatory">
            <div className="obs-top">
              <span>
                <span className="status-dot" /> MERV / RESEARCH ENGINE
              </span>
              <span className="example">ILLUSTRATIVE WORKSPACE</span>
              <button
                className="icon-button"
                onClick={() => setPaused(!paused)}
                aria-label={
                  paused
                    ? "Play research animation"
                    : "Pause research animation"
                }
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
            </div>
            <div className="obs-body">
              <aside className="run-list">
                <div className="mini-label">
                  RESEARCH DIRECTIONS <span>03</span>
                </div>
                {runs.map((r, i) => (
                  <button
                    key={r.id}
                    className={
                      "run-button " + (selected === i ? "selected" : "")
                    }
                    aria-pressed={selected === i}
                    onClick={() => setSelected(i)}
                  >
                    <span className="run-id">
                      {r.id}
                      <span className={"tiny-dot dot-" + i} />
                    </span>
                    <strong>{r.short}</strong>
                    <span className="run-sub">
                      {i === selected
                        ? "Inspecting experiment"
                        : "Inspect experiment"}{" "}
                      <ArrowUpRight size={12} />
                    </span>
                  </button>
                ))}
                <div className="list-bottom">
                  <GitBranch size={14} /> One result. New directions.
                </div>
              </aside>
              <div className="engine">
                <div className="engine-head">
                  <div>
                    <span className="mini-label">
                      {run.id} / {stages[stage].toUpperCase()}
                    </span>
                    <h2>{run.name}</h2>
                  </div>
                  <span className="live-tag">SIMULATION</span>
                </div>
                <div className="pipeline" aria-label="Research stages">
                  {stages.map((s, i) => (
                    <React.Fragment key={s}>
                      <button
                        aria-pressed={i === stage}
                        className={
                          i === stage ? "active" : i < stage ? "done" : ""
                        }
                        onClick={() => {
                          setStage(i);
                          setPaused(true);
                        }}
                      >
                        <span>
                          {i < stage ? (
                            <Check size={12} />
                          ) : (
                            String(i + 1).padStart(2, "0")
                          )}
                        </span>
                        {s}
                      </button>
                      {i < 4 && <span className="connector" />}
                    </React.Fragment>
                  ))}
                </div>
                <div className="execution">
                  <div className="code-stream">
                    <span className="mini-label">
                      {stage === 0
                        ? "LITERATURE → HYPOTHESIS"
                        : stage === 1
                          ? "PLAN → DESIGN REVIEW"
                          : stage === 2
                            ? "SANDBOX → EXECUTION"
                            : stage === 3
                              ? "EVIDENCE → INDEPENDENT REVIEW"
                              : "FINDINGS → NEXT EXPERIMENT"}
                    </span>
                    {run.lines.map((line, i) => (
                      <div
                        key={line}
                        className={
                          "code-line " + (i === stage % 4 ? "current" : "")
                        }
                      >
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <i>{i === stage % 4 ? "›" : "·"}</i>
                        {line}
                      </div>
                    ))}
                  </div>
                  <div className="metric">
                    <span className="mini-label">EVIDENCE ACCUMULATES</span>
                    <svg
                      viewBox="0 0 200 90"
                      role="img"
                      aria-label="Illustrative trend, not measured results"
                    >
                      <path
                        d="M0 20H200M0 50H200M0 80H200"
                        stroke="#233329"
                        strokeDasharray="2 5"
                      />
                      <polyline
                        points={run.points}
                        fill="none"
                        stroke="#bbff91"
                        strokeWidth="1.7"
                      />
                      <polyline
                        points="0,71 30,69 60,65 90,67 120,60 150,63 180,57 200,58"
                        fill="none"
                        stroke="#657a6d"
                        strokeWidth="1.2"
                      />
                    </svg>
                    <span className="chart-key">
                      <i /> candidate <i /> baseline
                    </span>
                  </div>
                </div>
                <div className="hardware">
                  <Cpu size={15} />
                  <span>{run.hardware}</span>
                  <span className="hardware-runtime">{run.runtime}</span>
                  <span className="pulse-bars">▁▅▃▇▅▂▆</span>
                </div>
              </div>
            </div>
            <div className="obs-foot">
              <span>
                <span className="small-cross">+</span> Click a direction. Follow
                the work.
              </span>
              <span>IDEA → EXPERIMENT → EVIDENCE ↺</span>
            </div>
          </div>
          <div className="hero-bottom">
            <span>YOUR NEXT BREAKTHROUGH DESERVES MORE THAN A BACKLOG.</span>
            <span>SCROLL TO EXPLORE ↓</span>
          </div>
        </section>
        <section className="compat">
          <span>
            Works with the agents
            <br />
            you already use.
          </span>
          <div>Claude Code</div>
          <div>Codex</div>
          <div>Cursor</div>
          <div>GitHub Copilot</div>
          <a href="https://rapidreview.io/docs/merv">
            + MCP clients <ArrowUpRight size={13} />
          </a>
        </section>
        <section id="how-it-works" className="section loop-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 / THE COMPOUNDING LOOP</span>
              <h2>
                Don't just run more experiments.
                <br />
                <span>Learn how to run better ones.</span>
              </h2>
            </div>
            <p>
              Recursive self-improvement, made practical. Merv carries what your
              team learns into what it tries next—with review at every critical
              step.
            </p>
          </div>
          <div className="loop-layout">
            <div
              className={"loop-diagram " + (paused ? "paused" : "")}
              aria-label="Research ideas fan out into experiments, pass through review, and feed back into the next cycle"
            >
              <div className="source-nodes">
                <span>Research literature</span>
                <span>Your model & data</span>
                <span>Prior findings</span>
              </div>
              <svg
                viewBox="0 0 660 320"
                role="img"
                aria-label="Ideas enter Merv, fan out to GPU experiments, and return as reviewed evidence"
              >
                <defs>
                  <linearGradient id="line">
                    <stop stopColor="#58775d" />
                    <stop offset="1" stopColor="#bbff91" />
                  </linearGradient>
                </defs>
                <g fill="none" stroke="#314638">
                  <path d="M0 55C110 55 70 160 165 160M0 160H165M0 265C110 265 70 160 165 160" />
                  <path d="M270 160C330 160 320 55 380 55H445M270 160H445M270 160C330 160 320 265 380 265H445" />
                  <path d="M495 55C565 55 560 160 620 160M495 160H620M495 265C565 265 560 160 620 160" />
                  <path
                    className="return-line"
                    d="M620 165V310H220V211"
                    strokeDasharray="3 6"
                  />
                </g>
                {[55, 160, 265].map((y, i) => (
                  <g key={y}>
                    <rect
                      x="435"
                      y={y - 22}
                      width="65"
                      height="44"
                      rx="4"
                      fill="#101d15"
                      stroke="#49614c"
                    />
                    <text
                      x="467"
                      y={y + 4}
                      textAnchor="middle"
                      fill="#a7b7aa"
                      fontSize="11"
                      fontFamily="monospace"
                    >
                      GPU {i + 1}
                    </text>
                    <circle className="moving-dot" r="3" fill="#bbff91">
                      <animateMotion
                        dur={`${4 + i}s`}
                        repeatCount="indefinite"
                        path={`M0 ${y}C110 ${y} 70 160 165 160L270 160C330 160 320 ${y} 380 ${y}H495C565 ${y} 560 160 620 160`}
                      />
                    </circle>
                  </g>
                ))}
                <rect
                  x="165"
                  y="112"
                  width="110"
                  height="96"
                  rx="9"
                  fill="#baff91"
                />
                <text
                  x="220"
                  y="167"
                  textAnchor="middle"
                  fill="#132015"
                  fontSize="27"
                  fontWeight="600"
                >
                  merv
                </text>
                <circle
                  cx="620"
                  cy="160"
                  r="23"
                  fill="#18271c"
                  stroke="#95bc81"
                />
                <path
                  d="m610 160 7 7 13-15"
                  fill="none"
                  stroke="#bbff91"
                  strokeWidth="2"
                />
                <text
                  x="355"
                  y="296"
                  textAnchor="middle"
                  fill="#8da68f"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  REVIEWED FINDINGS INFORM THE NEXT CYCLE
                </text>
              </svg>
            </div>
            <div className="loop-steps">
              {[
                [
                  "01",
                  "Find the right question.",
                  "Connect research literature, your objectives, and prior results to design the next experiment.",
                ],
                [
                  "02",
                  "Put the idea to work.",
                  "Agents plan, implement, and execute on suitable compute. Independent review challenges the plan and the evidence.",
                ],
                [
                  "03",
                  "Make the next loop smarter.",
                  "Retain what worked and what failed. Reflect, refine the direction, and carry the learning forward.",
                ],
              ].map(([n, title, body]) => (
                <article key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section className="section inspect-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">02 / AUTONOMOUS. NOT OPAQUE.</span>
              <h2>
                A lot is happening.
                <br />
                <span>None of it has to be a mystery.</span>
              </h2>
            </div>
            <p>
              Zoom in from the research direction to the exact experiment. See
              what is being tested, how it runs, and what the evidence actually
              supports.
            </p>
          </div>
          <div className="inspection">
            <div
              className="inspection-tabs"
              role="tablist"
              aria-label="Experiment examples"
            >
              {runs.map((r, i) => (
                <button
                  role="tab"
                  id={"tab-" + i}
                  aria-controls="experiment-panel"
                  aria-selected={i === selected}
                  tabIndex={i === selected ? 0 : -1}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const next =
                        (selected + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                      setSelected(next);
                      document.getElementById("tab-" + next)?.focus();
                    }
                  }}
                  onClick={() => setSelected(i)}
                  key={r.id}
                >
                  {r.short}
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
            <div
              id="experiment-panel"
              role="tabpanel"
              aria-labelledby={"tab-" + selected}
              className="inspection-panel"
            >
              <div className="inspection-title">
                <span className="mini-label">
                  {run.id} / ILLUSTRATIVE EXPERIMENT
                </span>
                <h3>{run.idea}</h3>
              </div>
              <div className="detail-grid">
                <article>
                  <GitBranch />
                  <span className="mini-label">THE METHOD</span>
                  <p>{run.method}</p>
                </article>
                <article>
                  <Cpu />
                  <span className="mini-label">THE HARDWARE</span>
                  <h4>{run.hardware}</h4>
                  <p>{run.runtime}</p>
                </article>
                <article>
                  <CheckCheck />
                  <span className="mini-label">THE REVIEW</span>
                  <p>{run.review}</p>
                </article>
              </div>
              <div className="artifact-row">
                <span>RETAINED OUTPUT</span>
                <strong>{run.output}</strong>
                <span>Traceable. Inspectable. Reusable.</span>
              </div>
            </div>
          </div>
        </section>
        <section id="research" className="section research-section">
          <div className="research-copy">
            <span className="eyebrow">03 / YOUR RESEARCH ADVANTAGE</span>
            <h2>
              Start further
              <br />
              <span>ahead.</span>
            </h2>
            <p className="large-copy">
              Proprietary access to proven AI/ML ideas and techniques. A
              research engine to put them to the test.
            </p>
            <p>
              Bring your team closer to the ideas that matter. Merv pairs a
              curated research advantage with the machinery to evaluate
              techniques against your own models, data, and constraints.
            </p>
            <a href={CONTACT} className="text-link">
              Explore a research partnership <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="knowledge-visual">
            <div className="knowledge-top">
              <span className="mini-label">RESEARCH → PRACTICE</span>
              <span>↗</span>
            </div>
            <div className="knowledge-paper back-paper">
              <span>CONTINUAL LEARNING</span>
              <div />
              <div />
              <div />
            </div>
            <div className="knowledge-paper front-paper">
              <span className="mini-label">TECHNIQUE BRIEF / 007</span>
              <h3>
                Better ideas.
                <br />
                Grounded in evidence.
              </h3>
              <div className="paper-lines" />
              <div className="paper-tags">
                <span>Method</span>
                <span>Evidence</span>
                <span>Trade-offs</span>
              </div>
              <p>
                A result in the literature is a starting point.
                <br />
                Your evaluation decides what works for you.
              </p>
            </div>
            <div className="knowledge-bottom">
              <span className="status-dot" /> Built to become an experiment.
            </div>
          </div>
        </section>
        <section className="section control-section">
          <span className="eyebrow">04 / BUILT FOR THE WAY RESEARCH WORKS</span>
          <div className="control-grid">
            <article>
              <span className="feature-symbol">↳</span>
              <h3>Your direction.</h3>
              <p>
                Set the objective and constraints. Keep the research pointed at
                the problems that matter to your company.
              </p>
            </article>
            <article>
              <span className="feature-symbol">⌘</span>
              <h3>Your stack.</h3>
              <p>
                Work through your existing coding agent. Run locally or connect
                cloud sandboxes for heavier experiments.
              </p>
            </article>
            <article>
              <span className="feature-symbol">↺</span>
              <h3>Compounding knowledge.</h3>
              <p>
                Plans, reviews, artifacts, and findings stay connected. The next
                run starts with the context of the last.
              </p>
            </article>
          </div>
        </section>
        <section className="section faq-section">
          <div>
            <span className="eyebrow">A FEW GOOD QUESTIONS</span>
            <h2>
              Before you
              <br />
              <span>press run.</span>
            </h2>
          </div>
          <div className="faqs">
            {[
              [
                "What does recursive self-improvement mean here?",
                "A repeatable research cycle: propose an improvement, test it, independently review the evidence, and use the findings to choose the next experiment. It is a practical process for improving models and research decisions—not a promise of automatic breakthroughs.",
              ],
              [
                "Who is Merv for?",
                "ML and AI startups that have a model, a measurable objective, and more research ideas than time to investigate them. We work with teams exploring continual learning, model adaptation, inference efficiency, and other experimental directions.",
              ],
              [
                "Can I see what the agents are doing?",
                "Yes. Merv exposes research plans, experiments, reviews, retained artifacts, and compute activity. The examples on this page illustrate that workflow; they are not live customer runs or performance claims.",
              ],
              [
                "How do we start?",
                "Start a conversation about your model, evaluation criteria, available compute, and research goals. We will scope a pilot together. You can also explore the open-source Merv plugin and documentation.",
              ],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <Plus size={17} className="plus" />
                  <Minus size={17} className="minus" />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="closing">
          <span className="eyebrow">
            <span className="status-dot" /> THE NEXT ITERATION STARTS HERE.
          </span>
          <h2>
            Give your research
            <br />a <span>run button.</span>
          </h2>
          <p>Bring the ambition. Let's build the loop.</p>
          <a className="button primary" href={CONTACT}>
            Run Merv with your team <ArrowUpRight size={17} />
          </a>
          <Dialog.Root>
            <Dialog.Trigger className="install-trigger">
              Or start with the open-source plugin <ArrowRight size={14} />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content className="modal">
                <Dialog.Title>Run Merv in Codex</Dialog.Title>
                <Dialog.Description>
                  Connect your agent to the Merv research workflow.
                </Dialog.Description>
                <pre>
                  codex plugin marketplace add rapidreview-io/Merv
                  <br />
                  codex plugin add merv@rapidreview
                  <br />
                  codex mcp login merv
                </pre>
                <button className="button secondary" onClick={copy}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                  {copied ? "Copied" : "Copy commands"}
                </button>
                <a
                  className="text-link"
                  href="https://rapidreview.io/docs/merv"
                >
                  Other agents & documentation <ExternalLink size={14} />
                </a>
                <Dialog.Close
                  className="modal-close"
                  aria-label="Close installation instructions"
                >
                  <X />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </section>
      </main>
      <footer>
        <div className="footer-top">
          <a href="#" className="brand">
            <Mark />
            merv
          </a>
          <span>Research. Learn. Improve.</span>
          <div>
            <a href="https://github.com/rapidreview-io/Merv">
              GitHub <ArrowUpRight size={12} />
            </a>
            <a href="https://rapidreview.io/docs/merv">
              Documentation <ArrowUpRight size={12} />
            </a>
            <a href={CONTACT}>
              Contact <ArrowUpRight size={12} />
            </a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} Merv · Built by{" "}
            <a href="https://rapidreview.io">RapidReview</a>
          </span>
          <div>
            <a href="https://rapidreview.io/privacy">Privacy</a>
            <a href="https://rapidreview.io/terms">Terms</a>
            <span className="footer-status">
              <span className="status-dot" /> Always another question.
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
export default App;
