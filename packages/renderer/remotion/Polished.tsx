// Screen Studio-style composition over raw.mp4, driven by a precomputed Timeline
// (src/timeline.ts): speed ramps, auto-zoom, synthetic cursor + click ripples,
// criterion title cards, lower-third captions, verdict moments, and an end card.
import { AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { cursorAt, sourceTimeAt, zoomAt, type Timeline } from "../src/timeline";

export interface PolishedProps {
	video: string;
	title: string;
	timeline: Timeline;
}

const W = 1920;
const PAD_X = 112;
const PAD_TOP = 82;
const FRAME_W = W - 2 * PAD_X;
const FRAME_H = Math.round((FRAME_W * 9) / 16);
const RADIUS = 18;
const FONT = '"Inter", "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const STATUS = {
	pass: { color: "#22c55e", bg: "rgba(34,197,94,0.16)", label: "PASS", icon: "✓" },
	fail: { color: "#ef4444", bg: "rgba(239,68,68,0.16)", label: "FAIL", icon: "✕" },
	blocked: { color: "#f59e0b", bg: "rgba(245,158,11,0.16)", label: "BLOCKED", icon: "!" },
} as const;
const statusOf = (s: string) => STATUS[(s in STATUS ? s : "blocked") as keyof typeof STATUS];

const within = (t: number | null, a: number, b: number) => t != null && t >= a && t <= b;
/** 0..1..0 envelope with `fade` seconds of ramp at each end. */
const envelope = (t: number, a: number, b: number, fade = 0.2) => Math.max(0, Math.min(1, (t - a) / fade, (b - t) / fade));

function Cursor({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
	// Counter-scale so the pointer grows a little with zoom but not 1.8x.
	const s = 1.35 / Math.sqrt(scale);
	return (
		<svg width={32} height={32} viewBox="0 0 32 32" style={{ position: "absolute", left: x, top: y, transform: `translate(-6px,-4px) scale(${s})`, transformOrigin: "6px 4px", opacity, filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.35))" }}>
			<path d="M6 4 L6 26 L12 20 L16 29 L20 27 L16 18 L24 18 Z" fill="#111" stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
		</svg>
	);
}

function Ripple({ x, y, age }: { x: number; y: number; age: number }) {
	const r = interpolate(age, [0, 0.5], [6, 46], { extrapolateRight: "clamp" });
	const o = interpolate(age, [0, 0.5], [0.55, 0], { extrapolateRight: "clamp" });
	return <div style={{ position: "absolute", left: x - r, top: y - r, width: 2 * r, height: 2 * r, borderRadius: "50%", border: "4px solid #6366f1", background: "rgba(99,102,241,0.18)", opacity: o }} />;
}

function Pill({ children, opacity, style }: { children: React.ReactNode; opacity: number; style?: React.CSSProperties }) {
	return (
		<div style={{ position: "absolute", opacity, fontFamily: FONT, color: "#fff", background: "rgba(17,17,27,0.86)", backdropFilter: "blur(8px)", borderRadius: 14, padding: "14px 24px", boxShadow: "0 10px 30px rgba(0,0,0,0.35)", ...style }}>
			{children}
		</div>
	);
}

export const Polished: React.FC<PolishedProps> = ({ video, title, timeline: tl }) => {
	const frame = useCurrentFrame();
	const { t, segment } = sourceTimeAt(tl, frame);
	const base = FRAME_W / tl.screen.w;
	const z = t == null ? { scale: 1, cx: tl.screen.w / 2, cy: tl.screen.h / 2 } : zoomAt(tl.zoom, t);
	const k = base * z.scale;
	const layer = `translate(${FRAME_W / 2 - z.cx * k}px, ${FRAME_H / 2 - z.cy * k}px) scale(${k})`;

	const cur = t == null ? null : cursorAt(tl.cursor, t);
	const vis = t == null ? 0 : Math.max(0, ...tl.cursorVisible.map(([a, b]) => envelope(t, a, b, 0.25)));
	const caption = t == null || segment.kind !== "video" ? undefined : tl.captions.find((c) => within(t, c.start, c.end));
	const card = t == null ? undefined : tl.cards.find((c) => within(t, c.start, c.end));
	const mark = t == null ? undefined : tl.marks.find((m) => within(t, m.start, m.end));
	const freeze = segment.kind === "freeze" ? segment : null;
	const freezeAge = freeze ? (frame - freeze.from) / tl.fps : 0;

	if (segment.kind === "end") {
		const age = (frame - segment.from) / tl.fps;
		const st = statusOf(tl.end.overall);
		return (
			<AbsoluteFill style={{ background: "radial-gradient(120% 120% at 20% 10%, #312e81 0%, #0f172a 55%, #020617 100%)", fontFamily: FONT, color: "#fff", alignItems: "center", justifyContent: "center" }}>
				<div style={{ opacity: interpolate(age, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }), transform: `translateY(${interpolate(age, [0, 0.4], [24, 0], { extrapolateRight: "clamp" })}px)`, width: 1200 }}>
					<div style={{ fontSize: 30, opacity: 0.7, marginBottom: 18 }}>{tl.end.title}</div>
					<div style={{ display: "inline-flex", alignItems: "center", gap: 18, fontSize: 84, fontWeight: 800, color: st.color, marginBottom: 44 }}>
						<span>{st.icon}</span>
						<span>{st.label}</span>
					</div>
					{tl.end.criteria.map((c, i) => {
						const cs = statusOf(c.status);
						const o = interpolate(age, [0.3 + i * 0.12, 0.6 + i * 0.12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
						return (
							<div key={c.id} style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 32, padding: "14px 0", borderTop: "1px solid rgba(255,255,255,0.1)", opacity: o }}>
								<span style={{ width: 150, textAlign: "center", fontWeight: 700, fontSize: 24, color: cs.color, background: cs.bg, borderRadius: 999, padding: "6px 0" }}>{cs.label}</span>
								<span style={{ opacity: 0.6, width: 56 }}>{c.id}</span>
								<span>{c.description}</span>
							</div>
						);
					})}
				</div>
			</AbsoluteFill>
		);
	}

	return (
		<AbsoluteFill style={{ background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)" }}>
			<div style={{ position: "absolute", left: PAD_X, top: 26, fontFamily: FONT, fontSize: 28, fontWeight: 600, color: "rgba(255,255,255,0.92)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: FRAME_W - 260 }}>{title}</div>
			<div style={{ position: "absolute", right: PAD_X, top: 30, fontFamily: FONT, fontSize: 22, color: "rgba(255,255,255,0.7)" }}>ai-change-verifier</div>

			<div style={{ position: "absolute", left: PAD_X, top: PAD_TOP, width: FRAME_W, height: FRAME_H, borderRadius: RADIUS, overflow: "hidden", background: "#111", boxShadow: freeze ? "0 0 0 6px #ef4444, 0 30px 80px rgba(0,0,0,0.45)" : "0 30px 80px rgba(0,0,0,0.45)" }}>
				<div style={{ position: "absolute", left: 0, top: 0, width: tl.screen.w, height: tl.screen.h, transformOrigin: "0 0", transform: layer }}>
					{tl.segments.map((s) =>
						s.kind === "video" ? (
							<Sequence key={s.from} from={s.from} durationInFrames={s.frames} layout="none">
								<OffthreadVideo src={staticFile(video)} trimBefore={Math.round(s.srcStart * tl.fps)} playbackRate={s.rate} muted style={{ position: "absolute", width: tl.screen.w, height: tl.screen.h }} />
							</Sequence>
						) : null
					)}
					{freeze?.image ? <Img src={staticFile(freeze.image)} style={{ position: "absolute", width: tl.screen.w, height: tl.screen.h }} /> : null}
					{t != null && segment.kind === "video"
						? tl.clicks.filter((c) => t >= c.t && t - c.t < 0.5).map((c) => <Ripple key={c.t} x={c.x} y={c.y} age={t - c.t} />)
						: null}
					{cur && vis > 0 && !freeze ? <Cursor x={cur.x} y={cur.y} scale={z.scale} opacity={vis} /> : null}
				</div>

				{segment.kind === "video" && segment.fast ? (
					<Pill opacity={1} style={{ right: 22, top: 20, padding: "8px 16px", fontSize: 24, fontWeight: 600 }}>
						⏩ {Math.round(segment.rate)}×
					</Pill>
				) : null}

				{card && t != null ? (
					<Pill opacity={envelope(t, card.start, card.end, 0.25)} style={{ left: 28, top: 24, maxWidth: FRAME_W - 260, transform: `translateY(${(1 - envelope(t, card.start, card.end, 0.25)) * -12}px)` }}>
						<div style={{ fontSize: 20, letterSpacing: 2, opacity: 0.7, fontWeight: 600 }}>
							{card.id} · {card.kind.toUpperCase()}
						</div>
						<div style={{ fontSize: 34, fontWeight: 700, marginTop: 4 }}>{card.title}</div>
					</Pill>
				) : null}

				{mark && t != null && !freeze ? (
					<Pill opacity={envelope(t, mark.start, mark.end, 0.15)} style={{ right: 24, top: 70, fontSize: 32, fontWeight: 800, color: statusOf(mark.status).color, display: "flex", gap: 12, alignItems: "center" }}>
						<span style={{ fontSize: 40 }}>{statusOf(mark.status).icon}</span>
						{mark.id} {statusOf(mark.status).label}
					</Pill>
				) : null}

				{caption && t != null ? (
					<Pill opacity={envelope(t, caption.start, caption.end, 0.15)} style={{ left: "50%", bottom: 34, transform: "translateX(-50%)", fontSize: 32, fontWeight: 600, whiteSpace: "nowrap" }}>
						{caption.text}
					</Pill>
				) : null}

				{freeze ? (
					<Pill opacity={interpolate(freezeAge, [0, 0.2], [0, 1], { extrapolateRight: "clamp" })} style={{ left: 40, right: 40, bottom: 34, background: "rgba(127,29,29,0.92)", fontSize: 30 }}>
						<div style={{ fontWeight: 800, fontSize: 24, letterSpacing: 2, color: "#fecaca" }}>✕ {freeze.criterion} FAILED</div>
						<div style={{ marginTop: 6 }}>{freeze.explanation}</div>
					</Pill>
				) : null}
			</div>
		</AbsoluteFill>
	);
};
