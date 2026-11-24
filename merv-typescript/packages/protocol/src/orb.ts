/**
 * Merv's orb: a geodesic sphere, an icosahedron split twice into 320 flat faces lit from the top left.
 * The board draws it in its toolbar; Merv.app inlines this function by its source into the view that
 * draws the orb above every other, so it uses nothing from outside itself.
 */
/** `hearing` is what colours it: its agent's colour while the microphone takes what is said (or as
 *  Merv's mark), grey whenever it is not listening, and clear when muted. A live orb that hears also
 *  turns faster and breathes. */
export type OrbLook = { kind: 'off' | 'live'; hearing: boolean; muted: boolean; voice: string };

export function orbPainter(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  // Without a 2D context (a page with no screen) there is nothing to draw on.
  if (!ctx)
    return (_s: OrbLook, _size: number, _hovered: boolean, _now: number, _still: boolean) => {};
  const unit = (v: number[]) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  const mid = (a: number[], b: number[]) => unit(a.map((x, i) => x + b[i]!));
  const p = (1 + Math.sqrt(5)) / 2;
  const V = [
    [-1, p, 0],
    [1, p, 0],
    [-1, -p, 0],
    [1, -p, 0],
    [0, -1, p],
    [0, 1, p],
    [0, -1, -p],
    [0, 1, -p],
    [p, 0, -1],
    [p, 0, 1],
    [-p, 0, -1],
    [-p, 0, 1],
  ].map(unit);
  let mesh = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ].map((f) => f.map((i) => V[i]!));
  for (let k = 0; k < 2; k++)
    mesh = mesh.flatMap(([a, b, c]) => {
      const ab = mid(a!, b!),
        bc = mid(b!, c!),
        ca = mid(c!, a!);
      return [
        [a!, ab, ca],
        [b!, bc, ab],
        [c!, ca, bc],
        [ab, bc, ca],
      ];
    });
  // Base colours are the agents' own: Merv's blue, Claude's #D97757, Codex black.
  const COLORS: Record<string, number[][]> = {
    merv: [
      [30, 64, 175],
      [96, 150, 250],
    ],
    claude: [
      [160, 72, 46],
      [217, 119, 87],
    ],
    codex: [
      [0, 0, 0],
      [58, 58, 62],
    ],
    grey: [
      [92, 96, 106],
      [184, 188, 196],
    ],
  };
  const L = unit([-0.42, 0.6, 0.68]);
  let spin = 0.6,
    last = 0,
    breath = 0;
  /** One frame at `size` CSS pixels; `still` holds it unmoving. */
  return function paint(s: OrbLook, size: number, hovered: boolean, now: number, still: boolean) {
    const dt = Math.min((now - (last || now)) / 1000, 0.05);
    last = now;
    const hearing = s.kind === 'live' && s.hearing && !s.muted;
    if (!still) {
      spin += dt * (hearing ? 0.35 : 0.12);
      if (hearing) breath += dt * 2.6;
    }
    // Drawn at three times its size and clipped to a true circle, so the edge is smooth.
    const r = Math.min(globalThis.devicePixelRatio || 1, 2) * 3;
    if (canvas.width !== Math.round(size * r)) canvas.width = canvas.height = Math.round(size * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const [deep, lit] = COLORS[
      s.hearing && !s.muted ? (COLORS[s.voice] ? s.voice : 'merv') : 'grey'
    ]! as [number[], number[]];
    const dim = s.kind === 'off' && !hovered ? 0.78 : 1,
      R = (size / 2 - 0.5) * (hearing ? 1 + 0.03 * Math.sin(breath) : 1),
      c = size / 2;
    const cy = Math.cos(spin),
      sy = Math.sin(spin),
      cp = Math.cos(-0.38),
      sp = Math.sin(-0.38);
    const turn = ([x, y, z]: number[]) => {
      const a = x! * cy + z! * sy,
        b = z! * cy - x! * sy;
      return [a, y! * cp - b * sp, y! * sp + b * cp];
    };
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgb(' + deep.map((d) => Math.round(d * 0.55 * dim)).join(' ') + ')';
    ctx.fillRect(0, 0, size, size);
    const depth = (t: number[][]) => t[0]![2]! + t[1]![2]! + t[2]![2]!;
    const tris = mesh
      .map((f) => f.map(turn))
      .filter((t) => depth(t) > -0.2)
      .sort((a, b) => depth(a) - depth(b));
    for (const [a, b, cc] of tris as number[][][]) {
      const u = b!.map((x, i) => x - a![i]!),
        v = cc!.map((x, i) => x - a![i]!);
      let nm = unit([
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ]);
      if (nm[2]! < 0) nm = nm.map((x) => -x);
      const sm = unit([
        a![0]! + b![0]! + cc![0]!,
        a![1]! + b![1]! + cc![1]!,
        a![2]! + b![2]! + cc![2]!,
      ]);
      // Mostly smooth light, a little of each face's own: the facets show without glinting as they turn.
      const flat = Math.max(0, nm[0]! * L[0]! + nm[1]! * L[1]! + nm[2]! * L[2]!),
        soft = Math.max(0, sm[0]! * L[0]! + sm[1]! * L[1]! + sm[2]! * L[2]!);
      const light = 0.72 * soft + 0.28 * flat,
        t = Math.min(1, light);
      const rgb = deep.map((d, i) =>
        Math.round((d * (1 - t) + lit[i]! * t) * (0.55 + 0.45 * light) * dim),
      );
      ctx.fillStyle = s.muted
        ? 'rgba(255,255,255,' + (0.04 + 0.1 * light) + ')'
        : 'rgb(' + rgb.join(' ') + ')';
      ctx.strokeStyle = s.muted ? 'rgba(200,203,210,.4)' : ctx.fillStyle;
      ctx.lineWidth = s.muted ? 0.4 : 0.5;
      ctx.beginPath();
      [a!, b!, cc!].forEach(([x, y], i) => {
        const px = c + x! * R,
          py = c - y! * R;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (!s.muted) {
      // One soft highlight and an even rim, the same however it turns.
      const g = ctx.createRadialGradient(
        c - R * 0.38,
        c - R * 0.42,
        0,
        c - R * 0.38,
        c - R * 0.42,
        R * 0.7,
      );
      g.addColorStop(0, 'rgba(255,255,255,.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const rim = ctx.createRadialGradient(c, c, R * 0.72, c, c, R);
      rim.addColorStop(0, 'rgba(0,0,0,0)');
      rim.addColorStop(1, 'rgba(0,0,0,.28)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, size, size);
    }
    ctx.restore();
  };
}
