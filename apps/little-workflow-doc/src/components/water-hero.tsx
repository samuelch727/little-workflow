'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/*
  The home page hero. Thousands of flyers make one round body, like a drop of
  water. Each starts the same colour and slowly drifts to a colour of its own,
  the way agents drift apart once they are running. Then one more flies in and
  hits the body: the surface dents, the body wobbles, and a ripple spreads
  across from where it landed. Every flyer the ripple passes is back on the same
  colour. That ripple is one update. Click or tap to send more in, as fast as
  you like.
*/

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const BASE = [232, 234, 230];
// The four product colours from the avatars, a little brighter so they read on black
const TINTS = [[110, 190, 255], [184, 140, 245], [255, 170, 80], [150, 215, 100]];
// 0 is the shared colour; then three strengths of each tint
const GROUPS = [BASE.join(',')];
for (const tn of TINTS) for (let l = 1; l <= 3; l++) GROUPS.push(BASE.map((v, k) => Math.round(v + (tn[k] - v) * (l / 3))).join(','));

type Pointer = { x: number; y: number; nx: number; ny: number; vx: number; vy: number; on: boolean };
type Tap = { x: number; y: number };
// What flies in is a small cluster: a head and a few that trail it, each landing a moment after the last.
type Part = { lag: number; off: number; x: number; y: number; px: number; py: number; landed: boolean };
type Shot = { th: number; t0: number; dur: number; x0: number; y0: number; x1: number; y1: number; xc: number; yc: number; nx: number; ny: number; hit: boolean; parts: Part[] };
// Once it lands, each of them joins the body as one more flyer and slowly fades out.
type Joiner = { qx: number; qy: number; vx: number; vy: number; hd: number; born: number; life: number; x: number; y: number; size: number; inside: boolean };
type Wave = { v: number; x: number; y: number; t0: number };

// The water a moving disc pushes aside: carried along inside it, parted and drawn back around it.
function wake(rx: number, ry: number, vx: number, vy: number, s2: number, out: { x: number; y: number; c: number }) {
  const d2 = rx * rx + ry * ry;
  if (d2 < s2) { out.x = vx; out.y = vy; out.c = 1; return; }
  const f = s2 / d2, dot = (vx * rx + vy * ry) / d2;
  out.x = f * (2 * dot * rx - vx); out.y = f * (2 * dot * ry - vy); out.c = f;
}

// cx, cy, R place the body: beside the headline on a wide screen, centred above it on a phone
function makeWater(w: number, h: number, cx: number, cy: number, R: number) {
  const small = R < 150, N = Math.round(clamp(2800 * (R / 215) ** 2, 1300, 4200)), u = clamp(R / 190, 0.6, 1.25);
  const sig = clamp(R * 0.16, 26, 44), s2 = sig * sig;
  const mk = () => new Float32Array(N);
  // Each flyer wanders inside the body; qx, qy are its place in a unit disc, hd its heading
  const qx = mk(), qy = mk(), bsx = mk(), bsy = mk(), hd = mk(), sp = mk(), ox = mk(), oy = mk(), ovx = mk(), ovy = mk();
  const flash = mk(), x = mk(), y = mk(), px = mk(), py = mk(), t0 = mk(), delay = mk(), rate = mk(), top = mk(), m = mk();
  const ver = new Uint16Array(N), tone = new Uint8Array(N), hue = new Uint8Array(N);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  const fresh = (i: number, t: number, s = 1) => {
    t0[i] = t; delay[i] = (2 + Math.random() * 3) * s; rate[i] = 0.2 + Math.random() * 0.25;
    top[i] = 0.55 + Math.random() * 0.45; hue[i] = (Math.random() * TINTS.length) | 0; m[i] = 0;
  };
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt(Math.random()) * 0.97, b = Math.random() * TAU;
    qx[i] = r * Math.cos(b); qy[i] = r * Math.sin(b); hd[i] = Math.random() * TAU; sp[i] = 0.07 + Math.random() * 0.09;
    tone[i] = Math.random() < 0.45 ? 1 : 0; fresh(i, 0, 0.45);
  }

  // At rest the outline leans through a few slow lobes, so it is never quite a full circle and never the same shape twice.
  const LOBES = ([[2, 0.1], [3, 0.065], [4, 0.04], [5, 0.022]] as const).map(([n, a]) => ({
    n, a, f: 0.09 + Math.random() * 0.12, p: Math.random() * TAU, w: (Math.random() < 0.5 ? -1 : 1) * (0.04 + Math.random() * 0.08), q: 1.2 + Math.random(), g: 0.05 + Math.random() * 0.07,
  }));
  // A hit rings the body like a drop of water: each shape n wobbles at a rate that rises with n, and the fine ones settle first.
  const M = 144, edge = new Float32Array(M), W2 = TAU * 0.6, SIG = 0.5, DENT = 0.21;
  const MODES: { n: number; w: number; g: number; a: number }[] = [];
  for (let n = 2; n <= 7; n++) MODES.push({ n, w: W2 * Math.sqrt((n * (n - 1) * (n + 2)) / 8), g: 0.35 + 0.25 * n, a: Math.exp((-n * n * SIG * SIG) / 4) });
  let hits: { th: number; t0: number }[] = [];
  let bx = 0, by = 0, bvx = 0, bvy = 0;
  const surf = (t: number) => {
    for (let j = 0; j < M; j++) {
      const th = (j / M) * TAU;
      let d = 0;
      for (const l of LOBES) d += l.a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(l.f * t + l.p))) * Math.cos(l.n * th - l.w * t - l.q * Math.sin(l.g * t));
      let k = 0;
      for (const hit of hits) {
        const tau = t - hit.t0;
        for (const md of MODES) k -= DENT * md.a * Math.exp(-md.g * tau) * Math.sin(md.w * tau) * Math.cos(md.n * (th - hit.th));
      }
      // many hits at once still read as water: the dents add up, then ease off before the body turns inside out
      edge[j] = R * (1 + d + 0.32 * Math.tanh(k / 0.32));
    }
  };
  const edgeAt = (th: number) => {
    let f = (th / TAU) * M;
    if (f < 0) f += M;
    const j = f | 0, k = f - j;
    return edge[j % M] * (1 - k) + edge[(j + 1) % M] * k;
  };

  const wk = { x: 0, y: 0, c: 0 }, LAM = 44 * u, SPEED = (2 * R) / 1.7;
  let version = 0, level = 0, drift = 0, primed = false, now = 0, shots: Shot[] = [], waves: Wave[] = [], joiners: Joiner[] = [];
  const PARTS = small ? 7 : 10;
  // Something flies in: from where you clicked, or from outside the frame
  const launch = (t: number, sx?: number, sy?: number) => {
    let th: number, x0: number, y0: number, dur: number;
    const aimed = sx !== undefined && sy !== undefined, off = aimed ? Math.hypot(sx - cx, sy - cy) - R : 0;
    if (aimed && off > 36 * u) { th = Math.atan2(sy - cy, sx - cx); x0 = sx; y0 = sy; dur = clamp(off / (480 * u), 0.3, 0.9); }
    else {
      th = aimed ? Math.atan2(sy - cy, sx - cx) : Math.random() * TAU;
      const b = th - 0.55, far = Math.hypot(w, h) * 0.6;
      x0 = cx + Math.cos(b) * far; y0 = cy + Math.sin(b) * far; dur = aimed ? 0.8 : 1.4;
    }
    const x1 = cx + Math.cos(th) * R * 1.02, y1 = cy + Math.sin(th) * R * 1.02, L = Math.hypot(x1 - x0, y1 - y0) || 1;
    const parts: Part[] = [];
    for (let k = 0; k < PARTS; k++) parts.push({ lag: k ? 0.03 + k * 0.028 + Math.random() * 0.03 : 0, off: k ? (Math.random() - 0.5) * 22 * u : 0, x: x0, y: y0, px: x0, py: y0, landed: false });
    shots.push({ th, t0: t, dur, x0, y0, x1, y1, xc: (x0 + x1) / 2 - (y1 - y0) * 0.22, yc: (y0 + y1) / 2 + (x1 - x0) * 0.22, nx: -(y1 - y0) / L, ny: (x1 - x0) / L, hit: false, parts });
  };

  return {
    step(dt: number, t: number, p: Pointer, taps: Tap[]) {
      for (const tap of taps) if (shots.length < 24) launch(t, tap.x, tap.y);
      if (!shots.length && !waves.length && (drift > 0.72 || t - level > 9)) launch(t);
      now = t;
      const landed: Shot[] = [];
      shots = shots.filter((s) => {
        for (const pt of s.parts) {
          if (pt.landed) continue;
          const q = clamp((t - s.t0 - pt.lag) / s.dur, 0, 1), e = q * q, k1 = 1 - e, o = pt.off * (1 - e);
          pt.px = pt.x; pt.py = pt.y;
          pt.x = k1 * k1 * s.x0 + 2 * k1 * e * s.xc + e * e * s.x1 + s.nx * o; pt.y = k1 * k1 * s.y0 + 2 * k1 * e * s.yc + e * e * s.y1 + s.ny * o;
          if (q < 1) continue;
          pt.landed = true;
          // it carries on from where it is, with the speed it came in at, plunges into the body and slows to the pace of the rest
          const rx = pt.x - cx - bx, ry = pt.y - cy - by, B0 = edgeAt(Math.atan2(ry, rx));
          let vx = (pt.x - pt.px) / Math.max(dt, 1e-3), vy = (pt.y - pt.py) / Math.max(dt, 1e-3);
          const speed = Math.hypot(vx, vy) || 1, cap = (1.7 + Math.random() * 0.6) * R;
          if (speed > cap) { vx *= cap / speed; vy *= cap / speed; }
          joiners.push({ qx: rx / B0, qy: ry / B0, vx: vx / R, vy: vy / R, hd: Math.atan2(vy, vx), born: t, life: 5 + Math.random() * 2.5, x: pt.x, y: pt.y, size: pt === s.parts[0] ? 2.2 : 1.6, inside: false });
        }
        if (!s.hit && s.parts[0].landed) {
          s.hit = true; version++;
          waves.push({ v: version, x: s.x1, y: s.y1, t0: t });
          hits.push({ th: s.th, t0: t });
          bvx -= Math.cos(s.th) * 120 * u; bvy -= Math.sin(s.th) * 120 * u;
          landed.push(s);
        }
        return s.parts.some((pt) => !pt.landed);
      });
      hits = hits.filter((hit) => t - hit.t0 < 5);
      bvx += (-18 * bx - 4.5 * bvx) * dt; bvy += (-18 * by - 4.5 * bvy) * dt; bx += bvx * dt; by += bvy * dt;
      surf(t);

      const lim = 1.03 + 0.06 * Math.exp(-version / 3), soft = lim - 0.12, sdt = Math.sqrt(dt), SW = 0.05;
      const active = p.on && p.vx * p.vx + p.vy * p.vy > 900;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        px[i] = x[i]; py[i] = y[i];
        const qx0 = qx[i], qy0 = qy[i];
        // wander, turning back in near the surface
        hd[i] += gauss() * 0.7 * sdt;
        let r = Math.hypot(qx[i], qy[i]);
        if (r > soft) {
          let d = Math.atan2(-qy[i], -qx[i]) - hd[i];
          d -= TAU * Math.round(d / TAU);
          hd[i] += d * clamp((r - soft) / 0.12, 0, 1) * 6 * dt;
        }
        qx[i] += (Math.cos(hd[i]) * sp[i] - SW * qy[i]) * dt; qy[i] += (Math.sin(hd[i]) * sp[i] + SW * qx[i]) * dt;
        r = Math.hypot(qx[i], qy[i]);
        if (r > lim) { qx[i] *= lim / r; qy[i] *= lim / r; }
        const B = edgeAt(Math.atan2(qy[i], qx[i]));
        let X = cx + bx + qx[i] * B, Y = cy + by + qy[i] * B;
        // the mark starts where the flyer was, carried along with the body, so a wobble moves it without smearing it
        if (primed) { const B0 = edgeAt(Math.atan2(qy0, qx0)); px[i] += cx + bx + qx0 * B0 - bsx[i]; py[i] += cy + by + qy0 * B0 - bsy[i]; }
        bsx[i] = X; bsy[i] = Y;
        let dx = 0, dy = 0;
        for (const wv of waves) {
          const rx = X - wv.x, ry = Y - wv.y, dd = Math.hypot(rx, ry) || 1, front = (t - wv.t0) * SPEED;
          if (ver[i] < wv.v && dd <= front) { ver[i] = wv.v; flash[i] = 1; fresh(i, t); }
          // rings spread from where it landed, the way they spread across water
          const s = front - dd;
          if (s > 0 && s < 4 * LAM) {
            const a = 10 * u * Math.exp(-(t - wv.t0) / 1.3) * Math.sin((TAU * s) / LAM) * Math.exp(-s / (1.6 * LAM));
            dx += (rx / dd) * a; dy += (ry / dd) * a;
          }
        }
        for (const sh of landed) {
          const rx = X - sh.x1, ry = Y - sh.y1, dd = Math.hypot(rx, ry) || 1;
          if (dd < 0.34 * R) {
            const f = 150 * u * (1 - dd / (0.34 * R)), nx = Math.cos(sh.th), ny = Math.sin(sh.th);
            ovx[i] += ((rx / dd) * 0.5 + nx * 0.5) * f; ovy[i] += ((ry / dd) * 0.5 + ny * 0.5) * f;
          }
        }
        X += dx; Y += dy;
        if (flash[i] > 0) flash[i] -= dt * 1.6;
        m[i] = clamp((t - t0[i] - delay[i]) * rate[i], 0, top[i]);
        sum += m[i];
        let ax = -ox[i] * 40 - ovx[i] * 9, ay = -oy[i] * 40 - ovy[i] * 9;
        if (active) {
          const rx = X - p.x, ry = Y - p.y;
          if (rx * rx + ry * ry < s2 * 16) { wake(rx, ry, p.vx, p.vy, s2, wk); ax += (wk.x - ovx[i] * wk.c) * 8; ay += (wk.y - ovy[i] * wk.c) * 8; }
        }
        ovx[i] += ax * dt; ovy[i] += ay * dt; ox[i] += ovx[i] * dt; oy[i] += ovy[i] * dt;
        x[i] = X + ox[i]; y[i] = Y + oy[i];
        if (!primed) { px[i] = x[i]; py[i] = y[i]; }
      }
      primed = true;
      joiners = joiners.filter((j) => {
        if (t - j.born > j.life) return false;
        let r = Math.hypot(j.qx, j.qy) || 1;
        if (!j.inside && r < 0.99) j.inside = true;
        if (!j.inside) {
          // where the surface is dented it has not reached the body yet: it flies on, bending toward it, and never jumps
          const v = Math.max(Math.hypot(j.vx, j.vy), 1), k = Math.min(1, dt * 4);
          j.vx += ((-j.qx / r) * v - j.vx) * k; j.vy += ((-j.qy / r) * v - j.vy) * k;
          j.qx += j.vx * dt; j.qy += j.vy * dt;
        } else {
          // the plunge slows like something sinking into water, then it wanders with the others
          const drag = Math.exp(-dt * 2.4);
          j.vx *= drag; j.vy *= drag;
          j.hd += gauss() * 0.7 * sdt;
          if (r > soft) { let d = Math.atan2(-j.qy, -j.qx) - j.hd; d -= TAU * Math.round(d / TAU); j.hd += d * clamp((r - soft) / 0.12, 0, 1) * 6 * dt; }
          const calm = clamp(1 - Math.hypot(j.vx, j.vy) / 0.3, 0, 1) * 0.12;
          j.qx += (j.vx + Math.cos(j.hd) * calm) * dt; j.qy += (j.vy + Math.sin(j.hd) * calm) * dt;
          r = Math.hypot(j.qx, j.qy);
          if (r > lim) { j.qx *= lim / r; j.qy *= lim / r; }
        }
        const B = edgeAt(Math.atan2(j.qy, j.qx));
        j.x = cx + bx + j.qx * B; j.y = cy + by + j.qy * B;
        return true;
      });
      drift = sum / (N * 0.775);
      const before = waves.length;
      waves = waves.filter((wv) => (t - wv.t0) * SPEED <= 2.2 * R + 4 * LAM);
      if (waves.length < before) level = t;
    },
    draw(c: CanvasRenderingContext2D) {
      const hot = GROUPS.length * 2, paths: Path2D[] = [], used: boolean[] = [];
      for (let g = 0; g <= hot; g++) { paths.push(new Path2D()); used.push(false); }
      for (let i = 0; i < N; i++) {
        const g = flash[i] > 0.45 ? hot : (m[i] < 0.17 ? 0 : 1 + hue[i] * 3 + (m[i] < 0.5 ? 0 : m[i] < 0.83 ? 1 : 2)) * 2 + tone[i];
        const q = paths[g];
        // a round dot at rest, a short mark while it moves; nothing is left behind
        if (Math.abs(x[i] - px[i]) + Math.abs(y[i] - py[i]) < 1.2) { q.moveTo(x[i] - 0.1, y[i]); q.lineTo(x[i] + 0.1, y[i]); }
        else { q.moveTo(px[i], py[i]); q.lineTo(x[i], y[i]); }
        used[g] = true;
      }
      c.lineCap = 'round';
      for (let g = 0; g < hot; g++) {
        if (!used[g]) continue;
        c.lineWidth = g & 1 ? 1.5 : 1.9; c.strokeStyle = `rgba(${GROUPS[g >> 1]},${g & 1 ? 0.55 : 0.95})`; c.stroke(paths[g]);
      }
      if (used[hot]) { c.lineWidth = 2.1; c.strokeStyle = 'rgba(246,249,255,1)'; c.stroke(paths[hot]); }
      // what flies in is plain round dots, with no line behind them and no glow
      c.fillStyle = 'rgba(246,249,255,1)';
      for (const s of shots) {
        for (let k = 0; k < s.parts.length; k++) {
          const pt = s.parts[k];
          if (pt.landed || t0Of(s, pt) < 0) continue;
          c.beginPath(); c.arc(pt.x, pt.y, k ? 1.6 : 2.2, 0, TAU); c.fill();
        }
      }
      // once in the body they stay bright for a moment, a little larger than the rest, then fade
      for (const j of joiners) {
        const age = now - j.born;
        c.globalAlpha = age < 1.6 ? 1 : Math.pow(1 - (age - 1.6) / (j.life - 1.6), 1.6);
        c.beginPath(); c.arc(j.x, j.y, j.size, 0, TAU); c.fill();
      }
      c.globalAlpha = 1;
    },
    // the still frame for reduced motion is taken with an update part way across
    settled() { const last = waves[waves.length - 1]; return !!last && (now - last.t0) * SPEED > 0.9 * R; },
  };
  // a trailing part has not left yet until its own start time
  function t0Of(s: Shot, pt: Part) { return now - s.t0 - pt.lag; }
}

export function WaterHero({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const p: Pointer = { x: 0, y: 0, nx: 0, ny: 0, vx: 0, vy: 0, on: false };
    let taps: Tap[] = [];
    let w = 0, h = 0, dpr = 1, raf = 0, last = 0, t = 0, seen = false;
    let sim: ReturnType<typeof makeWater> | null = null;

    const paint = () => {
      if (!sim) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      sim.draw(ctx);
    };
    const frame = (stamp: number) => {
      const dt = last ? Math.min((stamp - last) / 1000, 1 / 30) : 1 / 60;
      last = stamp; t += dt;
      if (p.on) {
        const k = 1 - Math.exp(-dt * 18);
        p.vx += ((p.nx - p.x) / dt - p.vx) * k; p.vy += ((p.ny - p.y) / dt - p.vy) * k;
        p.x = p.nx; p.y = p.ny;
      } else { p.vx = p.vy = 0; }
      const fired = taps; taps = [];
      sim?.step(dt, t, p, fired);
      paint();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const start = () => { stop(); last = 0; if (!motion.matches && seen && !document.hidden && sim) raf = requestAnimationFrame(frame); };
    // Reduced motion: run it off screen until an update is part way across, then show that one frame.
    const still = () => {
      if (!sim) return;
      for (let i = 0; i < 1500; i++) { t += 1 / 60; sim.step(1 / 60, t, p, []); if (sim.settled()) break; }
      paint();
    };
    // On a wide screen the canvas fills the whole band and the body sits in the space right of the copy.
    const place = (rect: DOMRect) => {
      const copy = copyRef.current, inner = copy?.parentElement;
      if (!copy || !inner || getComputedStyle(canvas).position !== 'absolute') return { cx: w / 2, cy: h / 2, R: Math.min(w, h) * 0.38 };
      const from = copy.getBoundingClientRect().right - rect.left + 32;
      const to = inner.getBoundingClientRect().right - rect.left - parseFloat(getComputedStyle(inner).paddingRight);
      const room = Math.max(to - from, 240);
      return { cx: from + room / 2, cy: h / 2, R: Math.min(h * 0.36, room * 0.43) };
    };
    const size = (force = false) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      if (!force && sim && Math.abs(rect.width - w) < 2 && Math.abs(rect.height - h) < 2) return;
      w = rect.width; h = rect.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const b = place(rect);
      sim = makeWater(w, h, b.cx, b.cy, b.R); t = 0;
      if (motion.matches) still(); else { paint(); start(); }
    };

    const at = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      p.nx = e.clientX - r.left; p.ny = e.clientY - r.top;
      if (!p.on) { p.x = p.nx; p.y = p.ny; p.vx = p.vy = 0; }
      p.on = true;
    };
    const down = (e: PointerEvent) => { at(e); taps.push({ x: p.nx, y: p.ny }); if (motion.matches && sim) { sim.step(1 / 60, (t += 1 / 60), p, taps.splice(0)); } };
    const away = () => { p.on = false; };
    canvas.addEventListener('pointermove', at);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerleave', away);
    canvas.addEventListener('pointercancel', away);

    const resize = new ResizeObserver(() => size());
    resize.observe(canvas);
    const view = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; if (seen) start(); else stop(); }, { rootMargin: '80px' });
    view.observe(canvas);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    const onMotion = () => size(true);
    motion.addEventListener('change', onMotion);
    size(true);

    return () => {
      stop(); resize.disconnect(); view.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
      canvas.removeEventListener('pointermove', at);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerleave', away);
      canvas.removeEventListener('pointercancel', away);
    };
  }, []);

  return (
    <section className="water-hero" aria-labelledby="hero-title">
      <canvas
        ref={canvasRef}
        className="water-canvas"
        role="img"
        aria-label="Thousands of small flyers make one round body. They start the same colour and slowly drift to different colours. Every few seconds one more flies in and hits the body like a drop of water: it dents, wobbles, and a ripple spreads across it that returns every flyer to the same colour."
      />
      <div className="water-inner">
        <div ref={copyRef} className="water-copy">{children}</div>
      </div>
    </section>
  );
}
