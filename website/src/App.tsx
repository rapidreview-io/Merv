import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Pause,
  Play,
  RotateCcw,
  Plus,
  Minus,
  X,
  Database,
  FileBox,
  Layers3,
  LibraryBig,
  BrainCircuit,
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
    chip: "8 × H100",
    region: "GPU INSTANCES",
    kind: "VM",
    work: "replay-adapter",
    gpu: 8,
  },
  {
    id: "aws",
    shape: "p4d.24xlarge · 8× A100",
    chip: "8 × A100",
    region: "EC2 / CLOUD-INIT",
    kind: "VM",
    work: "routing-ablation",
    gpu: 8,
  },
  {
    id: "gcp",
    shape: "a3-highgpu-1g · 1× H100",
    chip: "1 × H100",
    region: "COMPUTE ENGINE",
    kind: "VM",
    work: "routing-seed",
    gpu: 1,
  },
  {
    id: "azure",
    shape: "NC24ads A100 v4 · 1× A100",
    chip: "1 × A100",
    region: "VIRTUAL MACHINES",
    kind: "VM",
    work: "held-out-eval",
    gpu: 1,
  },
  {
    id: "runpod",
    shape: "8× H100 SXM · 80 GB",
    chip: "8 × H100",
    region: "GPU PODS",
    kind: "POD",
    work: "distill-sweep",
    gpu: 8,
  },
  {
    id: "modal",
    shape: "4× H100 · GPU sandbox",
    chip: "4 × H100",
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
    x: 205,
    y: 58,
    w: 250,
    h: 120,
    start: 2,
    detail:
      "Two agents curate the corpus, freeze dataset/v4, and stage shards for E01 and E02. Runs in parallel with T02.",
    hardware: "16 vCPU · dataset/v4",
  },
  {
    id: "T02",
    kind: "TASK",
    name: "Evaluation harness",
    x: 625,
    y: 58,
    w: 250,
    h: 120,
    start: 2,
    detail:
      "Two agents prepare retention and quality evaluations for E03 against a pinned baseline. Runs in parallel with T01.",
    hardware: "8 vCPU · eval-suite/v2",
  },
  {
    id: "E01",
    kind: "EXPERIMENT",
    name: "Replay × LoRA",
    x: 90,
    y: 330,
    w: 260,
    h: 140,
    start: 7,
    detail:
      "Compare replay ratios and adapter ranks. Starts when T01 finishes, using the existing evaluation suite. It does not wait for another experiment.",
    hardware: "H100 · 4 independent seeds",
  },
  {
    id: "E02",
    kind: "EXPERIMENT",
    name: "Sparse routing",
    x: 410,
    y: 330,
    w: 260,
    h: 140,
    start: 7,
    detail:
      "Run routing ablations using the data from T01 and the existing evaluation suite. Starts when T01 finishes, alongside the other experiments.",
    hardware: "A100 · 4 ablation runs",
  },
  {
    id: "E03",
    kind: "EXPERIMENT",
    name: "Successor",
    x: 730,
    y: 330,
    w: 260,
    h: 140,
    start: 7,
    detail:
      "Test a successor hypothesis using data retained from the previous loop and the evaluation harness from T02. Starts when T02 finishes, without waiting for another experiment.",
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
  active = false,
  markerEnd,
}: {
  d: string;
  active?: boolean;
  markerEnd?: string;
}) {
  return (
    <g>
      <path className="wire" d={d} markerEnd={markerEnd} />
      {active && <path className="wire-pulse" d={d} pathLength="100" />}
    </g>
  );
}
function DagArrow({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="8"
        markerHeight="8"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M1 1L7 4L1 7" className="wire-arrow" />
      </marker>
    </defs>
  );
}
function useDiagramWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1080);
  useEffect(() => {
    if (!ref.current) return;
    // Spread the columns on wide screens without stretching marks or adding height.
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(1080, entry.contentRect.width / 1.2));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
function ResearchInput({
  x,
  y,
  kind,
  label,
  caption,
}: {
  x: number;
  y: number;
  kind: "user" | "research" | "evidence";
  label: string;
  caption?: string;
}) {
  const Icon =
    kind === "user"
      ? BrainCircuit
      : kind === "research"
        ? LibraryBig
        : Database;
  return (
    <g className={`research-input input-${kind}`}>
      <Icon
        x={x - 24}
        y={kind === "user" ? y - 70 : y - 24}
        width={48}
        height={48}
        strokeWidth={1}
        className="input-icon"
        aria-hidden="true"
      />
      <text
        key={label}
        x={x}
        y={kind === "user" ? y : y + 52}
        textAnchor="middle"
        className={`input-title ${kind === "user" ? "input-rotating" : ""}`}
      >
        {label}
      </text>
      {caption && (
        <text x={x} y={y + 19} textAnchor="middle" className="input-caption">
          {caption}
        </text>
      )}
    </g>
  );
}
function Ideas({ phase, reduced }: { phase: number; reduced: boolean }) {
  const { ref, width } = useDiagramWidth();
  const center = width / 2;
  const left = width * 0.2;
  const right = width * 0.8;
  const userInput = reduced
    ? "Problem / Model"
    : Math.floor(phase / 6) % 2 === 0
      ? "Problem"
      : "Model";
  const description =
    "Set your problem or model. Merv provides the prior research and evidence, grouped inside the system. Together they produce parallel experiments for applied AI research.";
  return (
    <div className="idea-field" ref={ref}>
      <svg
        className="ideas-desktop"
        viewBox={`0 0 ${width} 420`}
        role="img"
        aria-label={description}
      >
        <ResearchInput
          x={center}
          y={78}
          kind="user"
          label={userInput}
          caption="Set by you"
        />
        <Wire d={`M${center} 116V152`} />
        <g className="provided-context">
          <title>Provided by Merv</title>
          <rect
            x={width * 0.07}
            y="152"
            width={width * 0.86}
            height="176"
            className="provided-field"
          />
          <ResearchInput
            x={left}
            y={230}
            kind="research"
            label="Prior research"
          />
          <ResearchInput x={right} y={230} kind="evidence" label="Evidence" />
          <Wire d={`M${center} 152V168`} />
          <Wire d={`M${left + 36} 230H${center - 62}`} />
          <Wire d={`M${right - 36} 230H${center + 62}`} />
          <path
            d={`m${center - 4} 162 4 6 4-6M${center - 68} 226l6 4-6 4M${center + 68} 226l-6 4 6 4`}
            className="wire-arrow"
          />
          <circle cx={center} cy="230" r="56" className="idea-core" />
          <path
            d={`M${center - 19} 242v-27h7l12 14 12-14h7v27h-8v-15l-11 13-11-13v15z`}
            fill="var(--slate-12)"
          />
          <circle cx={center} cy="174" r="3" className="accent-dot" />
        </g>
        <Wire d={`M${center} 288V420`} active={phase < 3} />
        <text x={center + 16} y="373" className="svg-small">
          Experiments
        </text>
        <path d={`m${center - 4} 402 4 6 4-6`} className="wire-arrow" />
      </svg>
      <svg
        className="ideas-mobile"
        viewBox="0 0 360 380"
        role="img"
        aria-label={description}
      >
        <ResearchInput
          x={180}
          y={78}
          kind="user"
          label={userInput}
          caption="Set by you"
        />
        <Wire d="M180 116V152" />
        <g className="provided-context">
          <title>Provided by Merv</title>
          <rect
            x="0"
            y="152"
            width="360"
            height="168"
            className="provided-field"
          />
          <ResearchInput
            x={55}
            y={230}
            kind="research"
            label="Prior research"
          />
          <ResearchInput x={305} y={230} kind="evidence" label="Evidence" />
          <Wire d="M180 152V178" />
          <Wire d="M91 230H128" />
          <Wire d="M269 230H232" />
          <path
            d="m176 172 4 6 4-6M122 226l6 4-6 4M238 226l-6 4 6 4"
            className="wire-arrow"
          />
          <circle cx="180" cy="230" r="46" className="idea-core" />
          <path
            d="M161 242v-27h7l12 14 12-14h7v27h-8v-15l-11 13-11-13v15z"
            fill="var(--slate-12)"
          />
          <circle cx="180" cy="184" r="3" className="accent-dot" />
        </g>
        <Wire d="M180 278V380" active={phase < 3} />
        <text x="196" y="337" className="svg-small">
          Experiments
        </text>
        <path d="m176 362 4 6 4-6" className="wire-arrow" />
      </svg>
    </div>
  );
}
function Dag({
  phase,
  selected,
  onSelect,
}: {
  phase: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { ref, width } = useDiagramWidth();
  const center = width / 2;
  const layout = nodes.map((n) => {
    const w = Math.min((n.w * width) / 1080, n.kind === "TASK" ? 300 : 320);
    const cx = ((n.x + n.w / 2) * width) / 1080;
    return { ...n, x: cx - w / 2, w, cx };
  });
  const [taskLeft, taskRight, experimentLeft, , experimentRight] = layout;
  const selectedNode = nodes.find((n) => n.id === selected);
  return (
    <div className="dag-wrap">
      <div
        className="dag-canvas"
        ref={ref}
        style={{ "--diagram-ratio": `${width} / 630` } as CSSProperties}
        role="group"
        aria-label="T01 feeds E01 and E02. T02 feeds E03. Each experiment waits for its preparation task, never for another experiment."
      >
        <svg
          className="dag-wires"
          viewBox={`0 0 ${width} 630`}
          aria-hidden="true"
        >
          <DagArrow id="dag-arrow" />
          <Wire
            d={`M${taskLeft.cx} 178V254`}
            active={phase >= 7 && phase < 10}
          />
          <Wire
            d={`M${taskLeft.cx} 254H${experimentLeft.cx}V328`}
            markerEnd="url(#dag-arrow)"
          />
          <Wire
            d={`M${taskLeft.cx} 254H${center}V328`}
            markerEnd="url(#dag-arrow)"
          />
          <Wire
            d={`M${taskRight.cx} 178V254H${experimentRight.cx}V328`}
            markerEnd="url(#dag-arrow)"
          />
          <Wire d={`M${experimentLeft.cx} 470V525H${experimentRight.cx}V470`} />
          <Wire d={`M${center} 470V630`} />
        </svg>
        <svg
          className="dag-wires-mobile"
          viewBox="0 0 360 550"
          aria-hidden="true"
        >
          <DagArrow id="dag-arrow-mobile" />
          <Wire d="M85 155V218" active={phase >= 7 && phase < 10} />
          <Wire d="M85 218H60V278" markerEnd="url(#dag-arrow-mobile)" />
          <Wire d="M85 218H180V278" markerEnd="url(#dag-arrow-mobile)" />
          <Wire d="M275 155V218H300V278" markerEnd="url(#dag-arrow-mobile)" />
          <Wire d="M60 410V445H300V410" />
          <Wire d="M180 410V550" />
        </svg>
        {layout.map((n, index) => {
          const task = n.kind === "TASK";
          const end = task ? 7 : 21;
          const status =
            phase < n.start
              ? n.start === 2
                ? "queued"
                : "waiting"
              : phase < end
                ? "running"
                : task
                  ? "complete"
                  : "review";
          return (
            <button
              key={n.id}
              className={`dag-node ${task ? "task" : "experiment"} ${selected === n.id ? "selected" : ""} state-${status}`}
              style={
                {
                  "--x": `${(n.x / width) * 100}%`,
                  "--y": `${n.y / 6.3}%`,
                  "--w": `${(n.w / width) * 100}%`,
                  "--h": `${n.h / 6.3}%`,
                  "--mx": `${(task ? 10 + index * 190 : 5 + (index - 2) * 120) / 3.6}%`,
                  "--my": `${(task ? 50 : 280) / 5.5}%`,
                  "--mw": `${(task ? 150 : 110) / 3.6}%`,
                  "--mh": `${(task ? 105 : 130) / 5.5}%`,
                } as CSSProperties
              }
              onClick={() => onSelect(selected === n.id ? null : n.id)}
              aria-expanded={selected === n.id}
              aria-controls="workload-detail"
              aria-label={`${n.id} ${n.name}. ${status}. Inspect workload`}
            >
              <span className="node-id">
                <span>{n.id}</span>
                <i className="node-status" title={status} />
              </span>
              <strong>{n.name}</strong>
              <span className="node-agents" aria-hidden="true">
                {Array.from({ length: task ? 2 : 4 }, (_, i) => (
                  <i key={i} style={{ animationDelay: `${-i * 0.4}s` }} />
                ))}
              </span>
              <span
                className="node-meter"
                style={
                  {
                    "--work": `${status === "running" ? ((phase - n.start) / (end - n.start)) * 100 : status === "complete" || status === "review" ? 100 : 0}%`,
                  } as CSSProperties
                }
              />
            </button>
          );
        })}
      </div>
      <div id="workload-detail" hidden={!selectedNode}>
        {selectedNode && (
          <div className="dag-inspector">
            <span>{selectedNode.id}</span>
            <p>{selectedNode.detail}</p>
            <code>{selectedNode.hardware}</code>
            <button
              onClick={() => onSelect(null)}
              aria-label="Close workload details"
            >
              <X size={15} />
            </button>
          </div>
        )}
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
  const [mobile, setMobile] = useState(false);
  const [mobileProvider, setMobileProvider] = useState(pools[0].id);
  const providerTabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const media = matchMedia("(max-width: 650px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const selectProvider = (index: number) => {
    setMobileProvider(pools[index].id);
    setFocus(null);
  };
  const stage =
    phase < 5
      ? "Queued"
      : phase < 8
        ? "Provisioning"
        : phase < 10
          ? "Booting"
          : phase < 21
            ? "Training"
            : phase < 24
              ? "Capturing"
              : "Releasing";
  return (
    <div className="infra-system">
      <svg className="dispatch" viewBox="0 0 24 64" aria-hidden="true">
        <Wire d="M12 0V60" active={phase >= 5 && phase < 8} />
        <path d="m8 54 4 6 4-6" className="wire-arrow" />
      </svg>
      <div className="fleet-toolbar">
        <span>{mobile ? "4 workers" : "24 workers"}</span>
        <span className="fleet-state">
          <i className="signal" />
          {stage}
        </span>
        <button
          onClick={() => setFocus(null)}
          disabled={!focus}
          aria-label="Clear provider focus"
          title="Clear provider focus"
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div
        className="provider-tabs"
        role="tablist"
        aria-label="Compute providers"
      >
        {pools.map((pool, index) => {
          const provider = providers.find((item) => item[0] === pool.id)!;
          return (
            <button
              key={pool.id}
              ref={(element) => {
                providerTabs.current[index] = element;
              }}
              className="provider-tab"
              id={`provider-tab-${pool.id}`}
              role="tab"
              aria-selected={mobileProvider === pool.id}
              aria-controls={`provider-panel-${pool.id}`}
              tabIndex={mobileProvider === pool.id ? 0 : -1}
              onClick={() => selectProvider(index)}
              onKeyDown={(event) => {
                let next: number;
                switch (event.key) {
                  case "ArrowRight":
                    next = (index + 1) % pools.length;
                    break;
                  case "ArrowLeft":
                    next = (index + pools.length - 1) % pools.length;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = pools.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                selectProvider(next);
                providerTabs.current[next]?.focus();
              }}
            >
              <Logo id={pool.id} />
              <span>{provider[1]}</span>
            </button>
          );
        })}
      </div>
      <div className="fleet-grid">
        {pools.map((p, pi) => {
          const provider = providers.find((x) => x[0] === p.id)!;
          return (
            <article
              className={`pool ${mobileProvider === p.id ? "mobile-selected" : ""} ${focus && focus !== p.id ? "dimmed" : ""} ${focus === p.id ? "focused" : ""}`}
              key={p.id}
              id={`provider-panel-${p.id}`}
              role={mobile ? "tabpanel" : undefined}
              aria-labelledby={mobile ? `provider-tab-${p.id}` : undefined}
              tabIndex={mobile ? 0 : undefined}
            >
              <button
                className="pool-header"
                onClick={() => setFocus(focus === p.id ? null : p.id)}
                aria-expanded={focus === p.id}
                aria-controls={`pool-detail-${p.id}`}
                aria-label={`Inspect ${provider[1]} infrastructure`}
              >
                <Logo id={p.id} />
                <strong>{provider[1]}</strong>
                <span>{p.chip}</span>
              </button>
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
                  const id = `${p.kind}-${String(pi * 4 + w + 1).padStart(2, "0")}`;
                  return (
                    <div
                      className={`worker worker-${state}`}
                      key={w}
                      role="img"
                      aria-label={`${id}: ${p.gpu} ${p.gpu === 1 ? "GPU" : "GPUs"}. ${p.work}.${w + 1}, ${state}. Illustrative workload.`}
                      title={`${id} · ${p.work}.${w + 1} · ${state}`}
                    >
                      <div className="worker-id">
                        <span>{id}</span>
                        <i />
                      </div>
                      <div className="gpu-bank" aria-hidden="true">
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
                      <div className="train-track" aria-hidden="true">
                        <i
                          style={{
                            width: `${phase < 8 ? 0 : phase > 21 ? 100 : Math.min(99, (tick / 13) * 100)}%`,
                          }}
                        />
                      </div>
                      <svg
                        className="worker-spark"
                        viewBox="0 0 200 28"
                        aria-hidden="true"
                      >
                        <path
                          d={`M0 5L15 ${6 + w} 32 4 48 ${9 + pi} 62 8 79 14 95 11 111 16 130 13 146 21 161 19 179 24 200 25`}
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
              <div id={`pool-detail-${p.id}`} hidden={focus !== p.id}>
                <div className="pool-detail">
                  <span>{p.region}</span>
                  <span>{p.shape}</span>
                  <code>{p.work} × 4</code>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <div
        className="fabric-bottom"
        aria-label="Datasets, checkpoints and evidence are retained after compute is released."
      >
        <svg
          viewBox="0 0 1080 66"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <Wire d="M180 0V25H900V0M540 0V25" />
          <Wire d="M540 25V66" active={phase >= 21 && phase < 24} />
        </svg>
        <div className="artifacts">
          <div className="artifact-source">
            <FileBox size={38} strokeWidth={1} aria-hidden="true" />
            <span>Datasets</span>
          </div>
          <span className="artifact-connector" aria-hidden="true" />
          <div
            className="evidence-store"
            role="img"
            aria-label="Evidence store: a persistent database of run history and metrics, linked to datasets and checkpoints."
          >
            <Database
              className="evidence-database"
              size={100}
              strokeWidth={0.5}
              aria-hidden="true"
            />
            <strong>Evidence store</strong>
            <span>Run history · metrics</span>
          </div>
          <span className="artifact-connector" aria-hidden="true" />
          <div className="artifact-source">
            <Layers3 size={38} strokeWidth={1} aria-hidden="true" />
            <span>Checkpoints</span>
          </div>
        </div>
      </div>
    </div>
  );
}
export default function App() {
  const [phase, setPhase] = useState(12),
    [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
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
      <header>
        <div className="brand-lockup">
          <a className="brand" href="#" aria-label="Merv home">
            <Mark />
            merv
          </a>
          <span className="brand-credit">
            by <a href="https://rapidreview.io">rapidreview</a>
          </span>
        </div>
        <nav aria-label="Main navigation">
          <a href="https://rapidreview.io/docs/merv">
            Docs <ArrowUpRight size={12} />
          </a>
          <a href={CONTACT}>
            Run with us <ArrowUpRight size={14} />
          </a>
        </nav>
      </header>
      <main id="main">
        <div className="opening">
          <h1 aria-label="Continuous / Applied AI research.">
            <span className="headline-visual" aria-hidden="true">
              <span className="headline-swap">
                <span className="headline-track">
                  <span>Continuous</span>
                  <span>Applied</span>
                  <span>Continuous</span>
                </span>
              </span>
              <span className="headline-subject">AI research.</span>
            </span>
          </h1>
          <a
            className="follow-loop"
            href="#ideas"
            aria-label="Explore the research loop"
          >
            <ArrowDown size={28} strokeWidth={1} />
          </a>
        </div>
        <div className="system-controls">
          <div className="layer-tabs" aria-label="Jump to a layer">
            {["Inputs", "Experiments", "Compute"].map((s, i) => (
              <a
                href={"#" + ["ideas", "workloads", "infrastructure"][i]}
                key={s}
                aria-current={active === i ? "step" : undefined}
              >
                <span>{s}</span>
              </a>
            ))}
          </div>
          <span className="simulation">Illustrative loop</span>
          <button
            onClick={() => setPaused(!paused)}
            disabled={reduced}
            aria-label={
              reduced
                ? "Animation disabled: reduced motion"
                : stopped
                  ? "Play simulation"
                  : "Pause simulation"
            }
            title={
              reduced
                ? "Reduced motion"
                : stopped
                  ? "Play simulation"
                  : "Pause simulation"
            }
          >
            {stopped ? <Play size={13} /> : <Pause size={13} />}
          </button>
        </div>
        <div className="research-system">
          <section id="ideas" data-layer="0" className="layer idea-layer">
            <div className="layer-title">
              <h2>Research inputs.</h2>
            </div>
            <Ideas phase={phase} reduced={reduced} />
          </section>
          <div className="layer-bridge ideas-bridge" aria-hidden="true">
            <i />
          </div>
          <section
            id="workloads"
            data-layer="1"
            className="layer workload-layer"
          >
            <div className="layer-title">
              <h2>Parallel experiments.</h2>
            </div>
            <Dag phase={phase} selected={selected} onSelect={setSelected} />
          </section>
          <div className="layer-bridge dispatch-bridge" aria-hidden="true">
            <i />
          </div>
          <section
            id="infrastructure"
            data-layer="2"
            className="layer infra-layer"
          >
            <div className="layer-title">
              <h2>Compute built for agents.</h2>
            </div>
            <Fleet phase={phase} focus={focus} setFocus={setFocus} />
          </section>
        </div>
        <section
          className="integrations-layer"
          aria-labelledby="providers-heading"
        >
          <div className="integrations">
            <h3 id="providers-heading">20 cloud providers.</h3>
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
            <span className="tinker-mark">tinker</span>
            <span>
              Training API <span className="planned">Planned</span>
            </span>
            <div className="api-wire" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
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
          <a href="#ideas">
            <RotateCcw size={21} strokeWidth={1} />
            Learn. Repeat.
          </a>
        </div>
        <section className="closing">
          <h2>Your next idea?</h2>
          <a href={CONTACT}>
            Let’s run it <ArrowUpRight size={24} strokeWidth={1} />
          </a>
        </section>
      </main>
      <footer>
        <a href="#" className="brand" aria-label="Merv home">
          <Mark />
          merv
        </a>
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
