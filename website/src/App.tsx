import { useEffect, useState } from "react";
import { ArrowDown, ArrowUpRight, Pause, Play } from "lucide-react";

const CONTACT = "mailto:gural@rapidreview.io?subject=Merv%20research%20pilot";
const layers = ["Ideation", "Execution", "GPU infrastructure"];
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
function Flow({ path, delay = 0 }: { path: string; delay?: number }) {
  return (
    <>
      <path d={path} className="wire" />
      <path d={path} className="flow" style={{ animationDelay: `${delay}s` }} />
    </>
  );
}
function Ideas() {
  return (
    <svg
      className="diagram ideas desktop-diagram"
      viewBox="0 0 900 440"
      role="img"
      aria-label="Research literature, proven techniques, and your goals converge into a testable idea"
    >
      <defs>
        <radialGradient id="ideaGlow">
          <stop stopColor="var(--blue-9)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--blue-9)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="450" cy="300" r="175" fill="url(#ideaGlow)" />
      {[190, 450, 710].map((x, i) => (
        <g key={x}>
          <Flow
            path={`M${x} 154V195Q${x} 224 ${x < 450 ? x + 30 : x > 450 ? x - 30 : x} 224H420Q450 224 450 254V288`}
            delay={i * -0.8}
          />
        </g>
      ))}
      {[
        {
          x: 85,
          label: "RESEARCH",
          title: "The next idea",
          sub: "Literature & prior findings",
        },
        {
          x: 345,
          label: "OUR ADVANTAGE",
          title: "Proven techniques",
          sub: "Proprietary research access",
        },
        {
          x: 605,
          label: "YOUR DIRECTION",
          title: "A better model",
          sub: "Goals, data & constraints",
        },
      ].map(({ x, label, title, sub }, i) => (
        <g className={`idea-card card-${i}`} key={label}>
          <rect
            x={x + 9}
            y="43"
            width="210"
            height="121"
            rx="10"
            className="paper-back"
          />
          <rect
            x={x}
            y="32"
            width="210"
            height="122"
            rx="10"
            className="paper"
          />
          <text x={x + 19} y="59" className="svg-label">
            {label}
          </text>
          <text x={x + 19} y="91" className="svg-title">
            {title}
          </text>
          <text x={x + 19} y="117" className="svg-sub">
            {sub}
          </text>
          <path
            d={`M${x + 19} 134h55m8 0h25`}
            stroke="var(--blue-7)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </g>
      ))}
      <circle cx="450" cy="300" r="50" className="orb-ring" />
      <circle cx="450" cy="300" r="38" fill="var(--blue-9)" />
      <path
        d="M434 311v-23h6l10 12 10-12h6v23h-7v-12l-9 11-9-11v12z"
        fill="white"
      />
      <text x="450" y="378" textAnchor="middle" className="output-label">
        A TESTABLE HYPOTHESIS
      </text>
      <Flow path="M450 395V440" />
    </svg>
  );
}
function Agents() {
  return (
    <svg
      className="diagram agents desktop-diagram"
      viewBox="0 0 900 480"
      role="img"
      aria-label="A hypothesis is planned, built, and independently reviewed by agents, then sent to compute"
    >
      <Flow path="M450 0V64" />
      <rect
        x="327"
        y="62"
        width="246"
        height="48"
        rx="24"
        className="agent-input"
      />
      <text x="450" y="91" textAnchor="middle" className="svg-sub on-dark">
        TESTABLE HYPOTHESIS
      </text>
      {[190, 450, 710].map((x, i) => (
        <Flow key={x} path={`M450 110V137Q450 155 ${x} 155V208`} delay={-i} />
      ))}
      {[
        { x: 90, title: "Plan", sub: "Design the experiment", symbol: "01" },
        { x: 350, title: "Build", sub: "Agents do the work", symbol: "02" },
        {
          x: 610,
          title: "Review",
          sub: "Challenge the evidence",
          symbol: "03",
        },
      ].map(({ x, title, sub, symbol }, i) => (
        <g key={title} className="agent-node">
          <rect
            x={x}
            y="207"
            width="200"
            height="159"
            rx="14"
            className="agent-box"
          />
          <circle
            cx={x + 100}
            cy="243"
            r="18"
            fill="var(--blue-9)"
            fillOpacity=".2"
          />
          <text
            x={x + 100}
            y="248"
            textAnchor="middle"
            className="svg-label blue"
          >
            {symbol}
          </text>
          <text
            x={x + 100}
            y="291"
            textAnchor="middle"
            className="svg-title on-dark"
          >
            {title}
          </text>
          <text
            x={x + 100}
            y="318"
            textAnchor="middle"
            className="svg-sub light-muted"
          >
            {sub}
          </text>
          <g className="activity" style={{ animationDelay: `${i * -0.5}s` }}>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <rect
                key={n}
                x={x + 70 + n * 9}
                y={344 - (n % 3) * 3}
                width="4"
                height={4 + (n % 3) * 3}
                rx="2"
                fill="var(--blue-10)"
              />
            ))}
          </g>
          <Flow
            path={`M${x + 100} 366V399Q${x + 100} 420 450 420V480`}
            delay={-i * 1.2}
          />
        </g>
      ))}
      <path
        d="M310 284h28m-5-5 5 5-5 5M570 284h28m-5-5 5 5-5 5"
        fill="none"
        stroke="var(--blue-8)"
      />
    </svg>
  );
}
function Compute() {
  return (
    <svg
      className="diagram compute"
      viewBox="0 0 900 470"
      role="img"
      aria-label="Agent experiments run on GPU infrastructure, with model checkpoints and evaluation evidence returned to the research loop"
    >
      <defs>
        <linearGradient id="rackTop" x2="0" y2="1">
          <stop stopColor="var(--blue-8)" />
          <stop offset="1" stopColor="var(--blue-11)" />
        </linearGradient>
      </defs>
      <Flow path="M450 0V42" />
      {[0, 1, 2].map((i) => (
        <g
          key={i}
          className="rack"
          style={{ animationDelay: `${i * -0.8}s` }}
          transform={`translate(0 ${i * 86})`}
        >
          <path
            d="M220 97 450 35 680 97 450 159Z"
            fill="url(#rackTop)"
            stroke="var(--blue-7)"
          />
          <path
            d="M220 97v45l230 64v-47Z"
            fill="var(--blue-11)"
            stroke="var(--blue-9)"
          />
          <path
            d="M450 159v47l230-64V97Z"
            fill="var(--blue-12)"
            stroke="var(--blue-9)"
          />
          {[0, 1, 2, 3].map((n) => (
            <g key={n} transform={`translate(${305 + n * 59} ${92 + n * 16})`}>
              <path
                d="m0 0 37-10 28 8-37 10Z"
                fill="var(--blue-5)"
                stroke="var(--blue-4)"
              />
              <path d="m2 0 26 7 34-9" fill="none" stroke="var(--blue-11)" />
            </g>
          ))}
          <path
            d="m242 117 115 32m-115-23 115 32"
            stroke="var(--blue-7)"
            strokeWidth="3"
            strokeDasharray="3 5"
          />
          {[0, 1, 2].map((n) => (
            <circle
              key={n}
              className="rack-led"
              cx={623 + n * 14}
              cy={131 - n * 4}
              r="2.5"
              fill="var(--blue-5)"
            />
          ))}
        </g>
      ))}
      <text x="126" y="175" className="svg-label" textAnchor="middle">
        GPU COMPUTE
      </text>
      <path d="M170 183h34" className="wire" />
      <text x="764" y="263" className="svg-label" textAnchor="middle">
        ISOLATED RUNS
      </text>
      <path d="M696 270h35" className="wire" />
      <Flow path="M450 379V425" />
      <rect x="308" y="423" width="284" height="38" rx="19" className="paper" />
      <text x="450" y="447" textAnchor="middle" className="svg-label">
        CHECKPOINTS + EVIDENCE
      </text>
    </svg>
  );
}
function MobileIdeas() {
  return (
    <svg
      className="diagram mobile-diagram"
      viewBox="0 0 350 460"
      role="img"
      aria-label="Research, proven techniques, and your goals become a testable hypothesis"
    >
      {[
        "Research & prior findings",
        "Proven AI/ML techniques",
        "Your model & goals",
      ].map((t, i) => (
        <g key={t}>
          <rect
            x="38"
            y={15 + i * 93}
            width="238"
            height="70"
            rx="10"
            className="paper"
          />
          <text x="57" y={42 + i * 93} className="svg-label">
            {["RESEARCH", "PROPRIETARY ACCESS", "YOUR DIRECTION"][i]}
          </text>
          <text x="57" y={65 + i * 93} className="svg-title">
            {t}
          </text>
          <Flow
            path={`M276 ${50 + i * 93}H303V318Q303 338 280 338H175V361`}
            delay={-i}
          />
        </g>
      ))}
      <circle cx="175" cy="372" r="30" fill="var(--blue-9)" />
      <path
        d="M161 381v-19h5l9 11 9-11h5v19h-5v-11l-9 10-9-10v11z"
        fill="white"
      />
      <text x="175" y="429" textAnchor="middle" className="output-label">
        A TESTABLE HYPOTHESIS
      </text>
      <Flow path="M175 443V460" />
    </svg>
  );
}
function MobileAgents() {
  return (
    <svg
      className="diagram mobile-diagram agents-mobile"
      viewBox="0 0 350 450"
      role="img"
      aria-label="Agents plan, build, and review the experiment before execution on GPUs"
    >
      <Flow path="M175 0V29" />
      {["Plan", "Build", "Review"].map((t, i) => (
        <g key={t}>
          <rect
            x="46"
            y={29 + i * 134}
            width="258"
            height="100"
            rx="12"
            className="agent-box"
          />
          <circle cx="82" cy={67 + i * 134} r="18" fill="var(--blue-4)" />
          <text
            x="82"
            y={72 + i * 134}
            textAnchor="middle"
            className="svg-label blue"
          >
            0{i + 1}
          </text>
          <text x="114" y={69 + i * 134} className="svg-title on-dark">
            {t}
          </text>
          <text x="114" y={96 + i * 134} className="svg-sub light-muted">
            {
              [
                "Design the experiment",
                "Agents do the work",
                "Challenge the evidence",
              ][i]
            }
          </text>
          <Flow path={`M175 ${129 + i * 134}V${163 + i * 134}`} delay={-i} />
        </g>
      ))}
    </svg>
  );
}
export default function App() {
  const [active, setActive] = useState(-1),
    [paused, setPaused] = useState(false);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".layer"));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting)
            setActive(Number((e.target as HTMLElement).dataset.layer));
        });
      },
      { rootMargin: "-25% 0px -35% 0px", threshold: 0 },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);
  return (
    <div className={paused ? "site paused" : "site"}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <a className="brand" href="#" aria-label="Merv home">
          <Mark />
          merv
        </a>
        <nav aria-label="Main navigation">
          <a href="#ideation">How it works</a>
          <a href="https://rapidreview.io/docs/merv">
            Docs <ArrowUpRight size={12} />
          </a>
        </nav>
        <a className="nav-cta" href={CONTACT}>
          Let’s talk <ArrowUpRight size={15} />
        </a>
      </header>
      <main id="main">
        <section className="hero">
          <div className="eyebrow">RECURSIVE SELF-IMPROVEMENT FOR AI TEAMS</div>
          <h1>
            Better ideas.
            <br />
            <span>Built into progress.</span>
          </h1>
          <p>
            Your research advantage. An agent workforce.
            <br />
            The compute to make it real.
          </p>
          <a className="primary" href={CONTACT}>
            Explore a pilot <ArrowUpRight size={17} />
          </a>
          <a className="scroll-cue" href="#ideation">
            THREE LAYERS. ONE RESEARCH LOOP.
            <ArrowDown size={18} />
          </a>
          <div className="hero-line" />
        </section>
        <div className="stack">
          <aside className="layer-nav" aria-label="Research layers">
            {layers.map((name, i) => (
              <a
                key={name}
                href={"#" + ["ideation", "execution", "infrastructure"][i]}
                aria-current={active === i ? "step" : undefined}
              >
                <span>0{i + 1}</span>
                <b>{name}</b>
              </a>
            ))}
          </aside>
          <section
            className={`layer ideation ${active === 0 ? "in-view" : ""}`}
            data-layer="0"
            id="ideation"
          >
            <div className="layer-heading">
              <span className="eyebrow">01 / IDEATION</span>
              <h2>Start with an edge.</h2>
              <p>Proven AI/ML techniques meet your next big question.</p>
            </div>
            <Ideas />
            <MobileIdeas />
            <div className="handoff">
              <span>IDEA BECOMES INTENT</span>
              <i />
            </div>
          </section>
          <section
            className={`layer execution ${active === 1 ? "in-view" : ""}`}
            data-layer="1"
            id="execution"
          >
            <div className="layer-heading">
              <span className="eyebrow">02 / EXECUTION</span>
              <h2>Put intelligence to work.</h2>
              <p>Agents turn the question into a reviewed experiment.</p>
            </div>
            <div className="agent-stage dark">
              <span className="stage-label">THE AGENT LAYER</span>
              <Agents />
              <MobileAgents />
              <span className="stage-foot">
                YOUR OBJECTIVE. COORDINATED EXECUTION.
              </span>
            </div>
            <div className="handoff">
              <span>INTENT BECOMES COMPUTE</span>
              <i />
            </div>
          </section>
          <section
            className={`layer infrastructure ${active === 2 ? "in-view" : ""}`}
            data-layer="2"
            id="infrastructure"
          >
            <div className="layer-heading">
              <span className="eyebrow">03 / GPU INFRASTRUCTURE</span>
              <h2>Real work. Under the hood.</h2>
              <p>
                GPU-backed experiments. Traceable results. Learning that stays.
              </p>
            </div>
            <Compute />
            <div className="return-loop">
              <svg viewBox="0 0 600 110" aria-hidden="true">
                <Flow path="M300 0V36Q300 60 276 60H80Q56 60 56 36V18" />
                <path d="m49 25 7-7 7 7" fill="none" stroke="var(--blue-9)" />
              </svg>
              <span>Every result informs the next idea.</span>
            </div>
          </section>
          <div className="visual-note">
            <span>ILLUSTRATED WORKFLOW</span>
            <button
              onClick={() => setPaused(!paused)}
              aria-label={paused ? "Play animations" : "Pause animations"}
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              <span>{paused ? "Play" : "Pause"}</span>
            </button>
          </div>
        </div>
        <section className="closing">
          <span className="eyebrow">LESS BACKLOG. MORE DISCOVERY.</span>
          <h2>
            Your next leap
            <br />
            starts with a question.
          </h2>
          <a className="primary" href={CONTACT}>
            Let’s find it together <ArrowUpRight size={17} />
          </a>
          <p>Research pilots for ML & AI startups.</p>
        </section>
      </main>
      <footer>
        <a className="brand" href="#" aria-label="Merv home">
          <Mark />
          merv
        </a>
        <span>Research that improves itself.</span>
        <div>
          <a href="https://github.com/rapidreview-io/Merv">GitHub</a>
          <a href="https://rapidreview.io/docs/merv">Docs</a>
          <a href="https://rapidreview.io/privacy">Privacy</a>
          <a href="https://rapidreview.io/terms">Terms</a>
        </div>
        <small>© {new Date().getFullYear()} RapidReview</small>
      </footer>
    </div>
  );
}
