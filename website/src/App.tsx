import { useEffect, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Pause,
  Play,
  RotateCcw,
  Plus,
  Minus,
} from "lucide-react";

const CONTACT = "mailto:gural@rapidreview.io?subject=Merv%20research%20pilot";
const providers = [
  ["lambda", "Lambda", "svg"],
  ["aws", "AWS", "svg"],
  ["gcp", "Google Cloud", "svg"],
  ["azure", "Azure", "svg"],
  ["runpod", "RunPod", "png"],
  ["modal", "Modal", "svg"],
  ["crusoe", "Crusoe", "png"],
  ["cloudflare", "Cloudflare", "svg"],
  ["digitalocean", "DigitalOcean", "svg"],
  ["vast", "Vast.ai", "png"],
  ["fluidstack", "Fluidstack", "png"],
  ["hyperstack", "Hyperstack", "png"],
  ["paperspace", "Paperspace", "svg"],
  ["vultr", "Vultr", "svg"],
  ["verda", "Verda", "svg"],
  ["tensordock", "TensorDock", "png"],
  ["thunder_compute", "Thunder Compute", "svg"],
  ["voltage_park", "Voltage Park", "png"],
  ["linode", "Akamai / Linode", "svg"],
  ["givemeanode", "GiveMeANode", "svg"],
];
const pools = [
  {
    id: "lambda",
    shape: "8× H100 SXM · 80 GB",
    region: "GPU INSTANCES",
    kind: "VM",
    work: "replay-adapter",
    gpu: 8,
  },
  {
    id: "aws",
    shape: "p4d.24xlarge · 8× A100",
    region: "EC2 / CLOUD-INIT",
    kind: "VM",
    work: "routing-ablation",
    gpu: 8,
  },
  {
    id: "gcp",
    shape: "a3-highgpu-1g · 1× H100",
    region: "COMPUTE ENGINE",
    kind: "VM",
    work: "routing-seed",
    gpu: 1,
  },
  {
    id: "azure",
    shape: "NC24ads A100 v4 · 1× A100",
    region: "VIRTUAL MACHINES",
    kind: "VM",
    work: "held-out-eval",
    gpu: 1,
  },
  {
    id: "runpod",
    shape: "8× H100 SXM · 80 GB",
    region: "GPU PODS",
    kind: "POD",
    work: "distill-sweep",
    gpu: 8,
  },
  {
    id: "modal",
    shape: "4× H100 · GPU sandbox",
    region: "ELASTIC CONTAINERS",
    kind: "BOX",
    work: "successor-trial",
    gpu: 4,
  },
];
const nodes = [
  {
    id: "T01",
    kind: "TASK",
    name: "Data engineering",
    sub: "dedupe → tokenize → shard",
    x: 205,
    y: 58,
    w: 250,
    h: 120,
    detail:
      "Two agents curate the corpus, freeze dataset/v4, and stage shards for every experiment. Runs in parallel with T02.",
    hardware: "16 vCPU · dataset/v4",
  },
  {
    id: "T02",
    kind: "TASK",
    name: "Evaluation harness",
    sub: "pin baseline → build evals",
    x: 625,
    y: 58,
    w: 250,
    h: 120,
    detail:
      "Two agents prepare retention and quality evaluations against the same pinned baseline. Runs in parallel with T01.",
    hardware: "8 vCPU · eval-suite/v2",
  },
  {
    id: "E01",
    kind: "EXPERIMENT",
    name: "Replay × LoRA",
    sub: "retention / adaptation",
    x: 90,
    y: 330,
    w: 260,
    h: 140,
    detail:
      "Compare replay ratios and adapter ranks. Starts when T01 and T02 finish; it does not wait for another experiment.",
    hardware: "H100 · 4 independent seeds",
  },
  {
    id: "E02",
    kind: "EXPERIMENT",
    name: "Sparse routing",
    sub: "quality / compute trade-off",
    x: 410,
    y: 330,
    w: 260,
    h: 140,
    detail:
      "Run routing ablations against the shared data and evaluation harness. Executes alongside E01 and E03.",
    hardware: "A100 · 4 ablation runs",
  },
  {
    id: "E03",
    kind: "EXPERIMENT",
    name: "Successor: distill",
    sub: "build on the previous loop",
    x: 730,
    y: 330,
    w: 260,
    h: 140,
    detail:
      "Test a successor hypothesis from the previous loop. In this loop it depends only on T01 and T02, not E01 or E02.",
    hardware: "H100 · 4 distillation runs",
  },
];
function Mark() {
  return (
    <svg viewBox="0 0 40 32" aria-hidden="true">
      <path
        d="M2 29V3h8l10 13L30 3h8v26h-8V16L20 29 10 16v13z"
        fill="currentColor"
      />
    </svg>
  );
}
function Logo({ id }: { id: string }) {
  const p = providers.find((p) => p[0] === id)!;
  return (
    <span className={`provider-logo logo-${id}`}>
      <img src={`/providers/${p[0]}.${p[2]}`} alt="" width="28" height="28" />
    </span>
  );
}
function Wire({
  d,
  delay = 0,
  active = true,
}: {
  d: string;
  delay?: number;
  active?: boolean;
}) {
  return (
    <g>
      <path className="wire" d={d} />
      {active && (
        <path
          className="wire-pulse"
          d={d}
          style={{ animationDelay: `${delay}s` }}
        />
      )}
    </g>
  );
}
function Ideas({ phase }: { phase: number }) {
  const topics = [
    {
      x: 88,
      y: 63,
      name: "EXISTING RESEARCH",
      sub: "papers / methods / evidence",
    },
    { x: 760, y: 66, name: "NEW HYPOTHESES", sub: "questions worth testing" },
    { x: 42, y: 260, name: "PRIOR LOOP", sub: "retained findings" },
    {
      x: 816,
      y: 260,
      name: "YOUR OBJECTIVE",
      sub: "model / data / constraints",
    },
  ];
  return (
    <div className="idea-field">
      <div className="field-corner top-left" />
      <div className="field-corner bottom-right" />
      <svg
        className="ideas-desktop"
        viewBox="0 0 1080 550"
        role="img"
        aria-label="New hypotheses combine existing research, proven techniques and findings from prior loops into three testable directions"
      >
        <defs>
          <radialGradient id="coreGlow">
            <stop stopColor="var(--blue-9)" stopOpacity=".27" />
            <stop offset="1" stopColor="var(--blue-9)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="540" cy="230" r="245" fill="url(#coreGlow)" />
        <g className="orbital">
          <ellipse cx="540" cy="230" rx="184" ry="86" />
          <ellipse
            cx="540"
            cy="230"
            rx="184"
            ry="86"
            transform="rotate(60 540 230)"
          />
          <ellipse
            cx="540"
            cy="230"
            rx="184"
            ry="86"
            transform="rotate(120 540 230)"
          />
        </g>
        <Wire d="M275 100H330Q355 100 380 130L482 205" />
        <Wire d="M805 108H750Q720 108 700 140L598 205" delay={-1} />
        <Wire d="M240 290H322Q350 290 375 275L480 241" delay={-2} />
        <Wire d="M840 290H762Q730 290 706 275L600 241" delay={-3} />
        {topics.map((t) => (
          <g key={t.name} className="idea-source">
            <text x={t.x} y={t.y} className="svg-micro">
              {t.name}
            </text>
            <text x={t.x} y={t.y + 25} className="svg-muted">
              {t.sub}
            </text>
            <path d={`M${t.x} ${t.y + 42}h180`} className="source-rule" />
            {[0, 1, 2, 3, 4].map((i) => (
              <rect
                key={i}
                x={t.x + i * 29}
                y={t.y + 53}
                width={11 + i * 2}
                height="3"
                fill="var(--blue-7)"
              />
            ))}
          </g>
        ))}
        {[
          { x: 372, y: 145, t: "replay" },
          { x: 661, y: 158, t: "LoRA" },
          { x: 382, y: 317, t: "routing" },
          { x: 634, y: 322, t: "distillation" },
        ].map((t, i) => (
          <g key={t.t} className="concept" style={{ animationDelay: `${-i}s` }}>
            <circle cx={t.x} cy={t.y} r="4" />
            <text x={t.x + 12} y={t.y + 4}>
              {t.t}
            </text>
          </g>
        ))}
        <circle className="core-ring" cx="540" cy="230" r="57" />
        <circle
          cx="540"
          cy="230"
          r="41"
          fill="var(--blue-4)"
          stroke="var(--blue-8)"
        />
        <path
          d="M521 242v-27h7l12 14 12-14h7v27h-8v-15l-11 13-11-13v15z"
          fill="var(--blue-11)"
        />
        <text x="540" y="371" textAnchor="middle" className="svg-micro">
          COMBINE · CHALLENGE · PROPOSE
        </text>
        <Wire d="M540 389V424M540 424H230V457M540 424V457M540 424H850V457" />
        {[
          "replay × low-rank adaptation",
          "sparse expert routing",
          "successor distillation",
        ].map((t, i) => (
          <g key={t}>
            <rect
              x={100 + i * 310}
              y="457"
              width="260"
              height="48"
              rx="2"
              className="hypothesis"
            />
            <text
              x={230 + i * 310}
              y="487"
              textAnchor="middle"
              className="svg-small"
            >
              {t}
            </text>
            <Wire d={`M${230 + i * 310} 505V550`} delay={-i} />
          </g>
        ))}
      </svg>
      <svg
        className="ideas-mobile"
        viewBox="0 0 360 430"
        role="img"
        aria-label="Existing research and new hypotheses combine with prior findings to create three experiment directions"
      >
        {[
          { x: 15, t: "EXISTING RESEARCH", sub: "methods + evidence" },
          { x: 205, t: "NEW HYPOTHESES", sub: "questions + intuition" },
        ].map((t) => (
          <g key={t.t}>
            <text x={t.x} y="24" className="svg-micro">
              {t.t}
            </text>
            <text x={t.x} y="49" className="svg-muted">
              {t.sub}
            </text>
            <Wire d={`M${t.x + 67} 66V98Q${t.x + 67} 119 180 119V173`} />
          </g>
        ))}
        <circle
          cx="180"
          cy="206"
          r="76"
          fill="none"
          stroke="var(--blue-5)"
          strokeDasharray="2 5"
        />
        <circle
          cx="180"
          cy="206"
          r="46"
          fill="var(--blue-3)"
          stroke="var(--blue-8)"
        />
        <text x="180" y="210" textAnchor="middle" className="svg-small">
          COMBINE
        </text>
        <Wire d="M26 215H132" />
        <text x="15" y="191" className="svg-micro">
          PRIOR LOOP
        </text>
        <Wire d="M228 215H334" />
        <text x="268" y="191" className="svg-micro">
          YOUR GOAL
        </text>
        <text x="180" y="302" textAnchor="middle" className="svg-micro">
          CHALLENGE → PROPOSE
        </text>
        {["Replay × LoRA", "Sparse routing", "Distillation"].map((t, i) => (
          <g key={t}>
            <Wire d={`M180 323V343H${60 + i * 120}V360`} />
            <rect
              x={7 + i * 120}
              y="360"
              width="106"
              height="42"
              className="hypothesis"
            />
            <text
              x={60 + i * 120}
              y="385"
              textAnchor="middle"
              className="svg-small"
            >
              {t}
            </text>
            <Wire d={`M${60 + i * 120} 402V430`} />
          </g>
        ))}
      </svg>
      <div className="idea-caption">
        <span>PROPRIETARY RESEARCH + OPEN-ENDED EXPLORATION</span>
        <span className="signal">
          {phase < 6 ? "FORMING HYPOTHESES" : "DIRECTIONS IN MOTION"}
        </span>
      </div>
    </div>
  );
}
function Dag({
  phase,
  selected,
  onSelect,
}: {
  phase: number;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const taskStatus = phase < 2 ? "queued" : phase < 7 ? "running" : "complete";
  const expStatus = phase < 7 ? "waiting" : phase < 21 ? "running" : "review";
  const selectedNode = nodes.find((n) => n.id === selected)!;
  return (
    <div className="dag-wrap">
      <div className="dag-topline">
        <span>LOOP / 001</span>
        <span>2 TASKS → 3 INDEPENDENT EXPERIMENTS</span>
        <span className="parallel-key">
          <i /> PARALLEL BRANCHES
        </span>
      </div>
      <div
        className="dag-scroll"
        tabIndex={0}
        role="region"
        aria-label="Research DAG: scroll horizontally on small screens"
      >
        <div className="dag-canvas">
          <svg
            className="dag-wires"
            viewBox="0 0 1080 630"
            role="img"
            aria-label="Task T01 and task T02 run in parallel. All three experiments depend on both tasks; no experiment depends on another experiment. Results collect at review."
          >
            <defs>
              <marker
                id="arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="m0 0 6 3.5L0 7" fill="none" stroke="var(--blue-8)" />
              </marker>
            </defs>
            <Wire d="M540 0V23H330V58M540 23H750V58" active={phase < 7} />
            <Wire
              d="M330 178V221Q330 245 354 245H726Q750 245 750 221V178"
              active={phase >= 7}
            />
            <text x="540" y="229" textAnchor="middle" className="svg-micro">
              DATA + EVALUATIONS READY
            </text>
            {[220, 540, 860].map((x, i) => (
              <g key={x}>
                <Wire
                  d={`M540 245V270H${x}V330`}
                  delay={-i}
                  active={phase >= 7}
                />
                <path
                  d={`M${x} 313V329`}
                  markerEnd="url(#arrow)"
                  className="wire"
                />
                <Wire
                  d={`M${x} 470V505Q${x} 531 540 531V560`}
                  delay={-i}
                  active={phase >= 20}
                />
              </g>
            ))}
            <rect
              x="402"
              y="559"
              width="276"
              height="48"
              rx="24"
              className="review-gate"
            />
            <text x="540" y="588" textAnchor="middle" className="svg-small">
              Review evidence → reflect
            </text>
            <Wire d="M540 607V630" active={phase >= 20} />
          </svg>
          {nodes.map((n) => {
            const status = n.kind === "TASK" ? taskStatus : expStatus;
            return (
              <button
                key={n.id}
                className={`dag-node ${n.kind.toLowerCase()} ${selected === n.id ? "selected" : ""} state-${status}`}
                style={{
                  left: `${n.x / 10.8}%`,
                  top: `${n.y / 6.3}%`,
                  width: `${n.w / 10.8}%`,
                  height: `${n.h / 6.3}%`,
                }}
                onClick={() => onSelect(n.id)}
                aria-pressed={selected === n.id}
                aria-label={`${n.id} ${n.name}. ${status}. Inspect workload`}
              >
                <span className="node-id">
                  <span>
                    {n.id} / {n.kind}
                  </span>
                  <span className="node-status">
                    <i />
                    {status}
                  </span>
                </span>
                <strong>{n.name}</strong>
                <span className="node-sub">{n.sub}</span>
                <span className="node-agents">
                  {n.kind === "TASK" ? (
                    <>
                      <i />
                      <i /> 2 agents
                    </>
                  ) : (
                    <>
                      <i />
                      <i />
                      <i />
                      <i /> 4 parallel trials
                    </>
                  )}
                </span>
                <span
                  className="node-meter"
                  style={
                    {
                      "--work": `${status === "running" ? (n.kind === "TASK" ? (phase - 2) / 5 : (phase - 7) / 14) * 100 : status === "complete" || status === "review" ? 100 : 0}%`,
                    } as CSSProperties
                  }
                />
              </button>
            );
          })}
        </div>
      </div>
      <div className="dag-inspector">
        <span>{selectedNode.id}</span>
        <p>{selectedNode.detail}</p>
        <code>{selectedNode.hardware}</code>
      </div>
      <div className="dag-rule">
        <span>Experiments wait on tasks. Never on each other.</span>
        <span>
          Next loop → new hypotheses + successor experiments{" "}
          <RotateCcw size={12} />
        </span>
      </div>
    </div>
  );
}
function Fleet({
  phase,
  focus,
  setFocus,
}: {
  phase: number;
  focus: string | null;
  setFocus: (id: string | null) => void;
}) {
  const stage =
    phase < 5
      ? "QUEUED"
      : phase < 8
        ? "PROVISIONING"
        : phase < 10
          ? "BOOTSTRAPPING"
          : phase < 21
            ? "RUNNING"
            : phase < 24
              ? "CAPTURING"
              : "RELEASING";
  return (
    <div className="infra-system">
      <div className="dispatch">
        <span>WORKLOAD DISPATCH</span>
        <div>
          <code>dataset/v4</code>
          <code>eval-suite/v2</code>
          <code>experiment spec</code>
          <code>checkpoint lineage</code>
        </div>
        <ArrowDown size={18} />
      </div>
      <div className="fleet-toolbar">
        <div>
          <span className="signal" /> COMPUTE FABRIC <b> / {stage}</b>
        </div>
        <span>ILLUSTRATIVE TOPOLOGY · 24 WORKERS</span>
        <button onClick={() => setFocus(null)} disabled={!focus}>
          ALL PROVIDERS
        </button>
      </div>
      <div className="fleet-grid">
        {pools.map((p, pi) => {
          const provider = providers.find((x) => x[0] === p.id)!;
          return (
            <article
              className={`pool ${focus && focus !== p.id ? "dimmed" : ""} ${focus === p.id ? "focused" : ""}`}
              key={p.id}
            >
              <button
                className="pool-header"
                onClick={() => setFocus(focus === p.id ? null : p.id)}
                aria-pressed={focus === p.id}
                aria-label={`Inspect ${provider[1]} infrastructure`}
              >
                <Logo id={p.id} />
                <span>
                  <strong>{provider[1]}</strong>
                  <small>{p.region}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
              <div className="pool-shape">
                {p.shape}
                <span>× 04</span>
              </div>
              <div className="workers">
                {[0, 1, 2, 3].map((w) => {
                  const tick = Math.max(0, phase - 8 - w * 0.28 - pi * 0.12);
                  const state =
                    phase < 5
                      ? "queued"
                      : tick < 0.5
                        ? "allocate"
                        : tick < 2
                          ? "boot"
                          : phase < 21
                            ? "train"
                            : phase < 24
                              ? "retain"
                              : "release";
                  return (
                    <div
                      className={`worker worker-${state}`}
                      key={w}
                      style={
                        { "--delay": `${(w + pi) * -0.3}s` } as CSSProperties
                      }
                    >
                      <div className="worker-id">
                        <span>
                          <i />
                          {p.kind}-{String(pi * 4 + w + 1).padStart(2, "0")}
                        </span>
                        <span>{state}</span>
                      </div>
                      <div className="gpu-bank">
                        {Array.from({ length: p.gpu }, (_, g) => (
                          <span
                            className="gpu"
                            key={g}
                            style={{
                              animationDelay: `${-(g + w + pi) * 0.3}s`,
                            }}
                          >
                            <i />
                            <i />
                            <i />
                            <i />
                          </span>
                        ))}
                      </div>
                      <div className="job-label">
                        <span>
                          {p.work}.{w + 1}
                        </span>
                        <span>
                          {phase >= 10 && phase < 21
                            ? `${Math.floor(tick * (117 + w * 13))} steps`
                            : state === "retain"
                              ? "checkpoint → R2"
                              : state === "release"
                                ? "lease closed"
                                : "env / cuda"}
                        </span>
                      </div>
                      <div className="train-track">
                        <i
                          style={{
                            width: `${phase < 8 ? 0 : phase > 21 ? 100 : Math.min(99, (tick / 13) * 100)}%`,
                          }}
                        />
                      </div>
                      <svg
                        className="worker-spark"
                        viewBox="0 0 200 22"
                        aria-hidden="true"
                      >
                        <path
                          d={`M0 5L15 ${6 + w} 32 4 48 ${9 + pi} 62 8 79 14 95 11 111 16 130 13 146 17 161 16 179 19 200 20`}
                          pathLength="100"
                          strokeDasharray="100"
                          strokeDashoffset={
                            phase < 9 ? 100 : Math.max(0, 100 - tick * 8)
                          }
                        />
                      </svg>
                    </div>
                  );
                })}
              </div>
              <div className="pool-footer">
                <span>stage → run → capture → release</span>
                <span>↳ retained artifacts</span>
              </div>
            </article>
          );
        })}
      </div>
      <div className="fabric-bottom">
        <div className="artifact-stream">
          <span>OUTPUT STREAM</span>
          {[
            "model.safetensors",
            "eval-results.json",
            "training.log",
            "dataset.manifest",
            "checkpoint/step-1200",
          ].map((s, i) => (
            <code key={s} style={{ animationDelay: `${-i * 1.2}s` }}>
              {s}
            </code>
          ))}
        </div>
        <div className="storage-line">
          <span>DATASETS / CHECKPOINTS / EVIDENCE</span>
          <strong>Kept after the machine is gone.</strong>
          <span>
            SSH certificates · durable jobs · snapshots · object storage
          </span>
        </div>
      </div>
    </div>
  );
}
export default function App() {
  const [phase, setPhase] = useState(12),
    [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(false),
    [selected, setSelected] = useState("E01"),
    [focus, setFocus] = useState<string | null>(null),
    [active, setActive] = useState(0);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (paused || reduced) return;
    const timer = setInterval(() => {
      if (!document.hidden) setPhase((p) => (p + 0.5) % 26);
    }, 500);
    return () => clearInterval(timer);
  }, [paused, reduced]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting)
            setActive(Number((e.target as HTMLElement).dataset.layer));
        }),
      { rootMargin: "-20% 0px -45% 0px" },
    );
    document
      .querySelectorAll("[data-layer]")
      .forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);
  const stopped = paused || reduced;
  return (
    <div className={`site dark ${stopped ? "paused" : ""}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <div className="blue-noise" aria-hidden="true" />
      <header>
        <a className="brand" href="#" aria-label="Merv home">
          <Mark />
          merv
        </a>
        <span className="header-label">RECURSIVE SELF-IMPROVEMENT</span>
        <nav aria-label="Main navigation">
          <a href="https://rapidreview.io/docs/merv">
            Documentation <ArrowUpRight size={12} />
          </a>
          <a href={CONTACT}>
            Run with us <ArrowUpRight size={14} />
          </a>
        </nav>
      </header>
      <main id="main">
        <div className="opening">
          <div>
            <span className="eyebrow">
              <i /> RESEARCH SYSTEM / MERV
            </span>
            <h1>
              Ideas become
              <br />
              <span>more than ideas.</span>
            </h1>
          </div>
          <div className="opening-aside">
            <p>
              New directions. Parallel experiments.
              <br />
              The infrastructure to keep going.
            </p>
            <a href="#ideas">
              FOLLOW ONE LOOP <ArrowDown size={14} />
            </a>
          </div>
        </div>
        <div className="system-controls">
          <div className="layer-tabs" aria-label="Jump to a layer">
            {["Ideas", "Workloads", "Infrastructure"].map((s, i) => (
              <a
                href={"#" + ["ideas", "workloads", "infrastructure"][i]}
                key={s}
                aria-current={active === i ? "step" : undefined}
              >
                0{i + 1}
                <span>{s}</span>
              </a>
            ))}
          </div>
          <button
            onClick={() => setPaused(!paused)}
            disabled={reduced}
            aria-label={stopped ? "Play simulation" : "Pause simulation"}
          >
            {stopped ? <Play size={12} /> : <Pause size={12} />}
            <span>
              {reduced
                ? "REDUCED MOTION"
                : stopped
                  ? "PLAY LOOP"
                  : "PAUSE LOOP"}
            </span>
          </button>
          <span className="simulation">
            ILLUSTRATIVE LOOP / NOT LIVE TELEMETRY
          </span>
        </div>
        <section id="ideas" data-layer="0" className="layer idea-layer">
          <div className="layer-title">
            <span className="layer-index">01</span>
            <div>
              <span className="eyebrow">IDEATION</span>
              <h2>
                Find the next <em>what if.</em>
              </h2>
            </div>
            <p>
              Invent a direction.
              <br />
              Combine what already works.
            </p>
          </div>
          <Ideas phase={phase} />
        </section>
        <div className="layer-bridge">
          <span>HYPOTHESES → EXECUTION GRAPH</span>
          <i />
          <i />
          <i />
        </div>
        <section id="workloads" data-layer="1" className="layer workload-layer">
          <div className="layer-title">
            <span className="layer-index">02</span>
            <div>
              <span className="eyebrow">SCHEMA → ACTION</span>
              <h2>One loop. Many things moving.</h2>
            </div>
            <p>
              Tasks prepare the ground.
              <br />
              Experiments explore in parallel.
            </p>
          </div>
          <Dag phase={phase} selected={selected} onSelect={setSelected} />
        </section>
        <div className="layer-bridge dispatch-bridge">
          <span>PARALLEL WORKLOADS → PROVISIONED COMPUTE</span>
          <i />
          <i />
          <i />
        </div>
        <section
          id="infrastructure"
          data-layer="2"
          className="layer infra-layer"
        >
          <div className="layer-title">
            <span className="layer-index">03</span>
            <div>
              <span className="eyebrow">INFRASTRUCTURE</span>
              <h2>
                Under every idea,
                <br />
                <em>a lot of machines.</em>
              </h2>
            </div>
            <p>
              VMs spin up. GPUs get to work.
              <br />
              Agents stay with the research.
            </p>
          </div>
          <Fleet phase={phase} focus={focus} setFocus={setFocus} />
          <div className="integrations">
            <div className="integration-intro">
              <span className="eyebrow">THE PROVIDER LAYER</span>
              <h3>
                One research workflow.
                <br />
                An entire compute ecosystem.
              </h3>
              <span>20 cloud provider adapters in Merv Sandboxes.</span>
            </div>
            <div className="provider-wall">
              {providers.map((p) => (
                <div key={p[0]}>
                  <Logo id={p[0]} />
                  <span>{p[1]}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="training-api">
            <div className="tinker-mark" aria-hidden="true">
              tinker
            </div>
            <div>
              <span className="eyebrow">TRAINING APIs / PLANNED</span>
              <h3>Another path from agent to training run.</h3>
              <p>Tinker is part of the integration roadmap.</p>
            </div>
            <span className="api-wire">SDK → TRAIN → SAMPLE → EVALUATE</span>
          </div>
          <details className="coverage">
            <summary>
              Integration coverage <Plus size={13} />
              <Minus size={13} />
            </summary>
            <p>
              Provider adapters are implemented. Live research workflows have
              been validated on Lambda A10 and Cloudflare CPU; DigitalOcean and
              GiveMeANode have CPU transfer validation. Other providers and
              hardware configurations require live validation. The fleet above
              illustrates possible workloads, not a running deployment or a
              performance claim.
            </p>
          </details>
        </section>
        <div className="loop-return">
          <RotateCcw size={20} />
          <span>Evidence returns. New ideas emerge.</span>
          <a href="#ideas">
            NEXT LOOP <ArrowUpRight size={14} />
          </a>
        </div>
        <section className="closing">
          <div>
            <span className="eyebrow">BUILD YOUR RESEARCH LOOP</span>
            <h2>
              What are you
              <br />
              trying to discover?
            </h2>
          </div>
          <a href={CONTACT}>
            Let’s put it in motion <ArrowUpRight size={25} />
          </a>
        </section>
      </main>
      <footer>
        <a href="#" className="brand" aria-label="Merv home">
          <Mark />
          merv
        </a>
        <span>Research that improves itself.</span>
        <div>
          <a href="https://github.com/rapidreview-io/Merv">GitHub ↗</a>
          <a href="https://rapidreview.io/docs/merv">Docs ↗</a>
          <a href="https://rapidreview.io/privacy">Privacy</a>
          <a href="https://rapidreview.io/terms">Terms</a>
        </div>
        <small>© {new Date().getFullYear()} RapidReview</small>
      </footer>
    </div>
  );
}
