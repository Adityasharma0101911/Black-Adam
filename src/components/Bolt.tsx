import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { useApp } from "../lib/store";

/** The brand bolt, as an SVG path in a 100x100 box (same shape as the app icon). */
export function BoltGlyph({ className, striped = true }: { className?: string; striped?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <defs>
        <linearGradient id="bolt-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.5" stopColor="#f59e0b" />
          <stop offset="1" stopColor="#b45309" />
        </linearGradient>
        <pattern id="bolt-bars" width="4.6" height="100" patternUnits="userSpaceOnUse">
          <rect width="3.4" height="100" fill="#fff" />
        </pattern>
        <mask id="bolt-mask">
          <rect width="100" height="100" fill={striped ? "url(#bolt-bars)" : "#fff"} />
        </mask>
      </defs>
      <polygon points="57,9 27,55 47,55 37,91 75,42 54,42 71,9" fill="url(#bolt-fill)" mask="url(#bolt-mask)" />
      <polygon points="57,9 27,55 47,55 37,91 75,42 54,42 71,9" fill="none" stroke="url(#bolt-fill)" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Radial spectrum + progress ring drawn on a canvas at display refresh rate. */
function Visualizer({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { tickRef } = useApp();

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    let raf = 0;
    let shown: number[] = new Array(48).fill(0);
    let prog = 0;
    let t0 = performance.now();

    const draw = (now: number) => {
      const tick = tickRef.current;
      const c = size / 2;
      const inner = size * 0.3;
      const maxLen = size * 0.17;
      ctx.clearRect(0, 0, size, size);
      const idle = !tick;
      const target = tick?.bands ?? shown.map((_, i) => 0.06 + 0.04 * Math.sin(now / 900 + i * 0.5));
      shown = shown.map((v, i) => v + ((target[i] ?? 0) - v) * (idle ? 0.06 : 0.35));
      prog += ((tick?.progress ?? 0) - prog) * 0.12;

      // 96 bars: 48 bands mirrored left/right
      const n = shown.length * 2;
      for (let i = 0; i < n; i++) {
        const v = shown[i < shown.length ? i : n - 1 - i];
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const len = 3 + v * maxLen;
        const x0 = c + Math.cos(a) * inner, y0 = c + Math.sin(a) * inner;
        const x1 = c + Math.cos(a) * (inner + len), y1 = c + Math.sin(a) * (inner + len);
        ctx.strokeStyle = `rgba(${245 + 8 * v}, ${158 + 70 * v}, ${11 + 100 * v}, ${idle ? 0.28 : 0.35 + 0.65 * v})`;
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // progress ring
      const r = size * 0.49 - 2;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
      if (tick) {
        const matching = tick.phase === "matching";
        const start = -Math.PI / 2 + (matching ? (now - t0) / 260 : 0);
        ctx.strokeStyle = "#f59e0b";
        ctx.shadowColor = "rgba(245,158,11,0.8)";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(c, c, r, start, start + Math.max(0.02, prog) * Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else t0 = now;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, tickRef]);

  return <canvas ref={ref} style={{ width: size, height: size }} className="pointer-events-none absolute inset-0" />;
}

export function ListenButton({ size = 320 }: { size?: number }) {
  const { listening, start, stop, phase, tickRef } = useApp();
  const glow = useRef<HTMLDivElement>(null);

  // Glow follows the audio level
  useEffect(() => {
    let raf = 0;
    let lv = 0;
    const loop = () => {
      lv += ((tickRef.current?.level ?? 0) - lv) * 0.2;
      if (glow.current) glow.current.style.opacity = String(0.25 + Math.min(1, lv * 6) * 0.75);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [tickRef]);

  const label = !listening ? "Identify song" : phase === "matching" ? "Matching" : phase === "cooldown" ? "Waiting for next song" : "Listening";

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <Visualizer size={size} />
      <div ref={glow} className="pointer-events-none absolute rounded-full bg-gold/30 blur-3xl" style={{ width: size * 0.5, height: size * 0.5 }} />
      <motion.button
        onClick={() => (listening ? stop() : start("once"))}
        aria-label={listening ? "Stop listening" : "Identify song"}
        className="relative grid cursor-pointer place-items-center rounded-full border border-gold/25 bg-gradient-to-b from-[#1c1a17] to-[#0a0a09] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_20px_60px_rgba(0,0,0,0.6)]"
        style={{ width: size * 0.52, height: size * 0.52 }}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.94 }}
        animate={listening ? { scale: [1, 1.025, 1] } : { scale: 1 }}
        transition={listening ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : { type: "spring", stiffness: 300, damping: 20 }}
      >
        <BoltGlyph className="h-[58%] w-[58%] drop-shadow-[0_0_18px_rgba(245,158,11,0.55)]" />
      </motion.button>
      <span className="sr-only" aria-live="polite">{label}</span>
    </div>
  );
}
