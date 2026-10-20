// Witness walkthrough video: the recorded app in a hairline frame, the criteria
// checklist filling in on the left, the current action captioned under the frame,
// and the evidence tape (criterion segments + playhead, in source time) below it.
// Driven by a precomputed Timeline (src/timeline.ts).
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { cursorAt, sourceTimeAt, zoomAt, type Timeline } from "../src/timeline";

export interface PolishedProps {
	video: string;
	title: string;
	timeline: Timeline;
}

const { fontFamily: SANS } = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const { fontFamily: MONO } = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

const C = {
	ink: "#0E0F10",
	surface: "#17181B",
	hairline: "#2A2C30",
	paper: "#E7E5E0",
	muted: "#8B8984",
	faint: "#4A4C50",
	pass: "#4CC38A",
	fail: "#F2555A",
	blocked: "#E2A336",
};
const STATUS: Record<string, string> = { pass: C.pass, fail: C.fail, blocked: C.blocked };

// Layout (1920x1080): header, criteria rail, 16:9 app frame, caption row, tape.
const HEADER_Y = 30;
const RAIL_X = 48;
const RAIL_W = 344;
const FRAME_X = 440;
const FRAME_Y = 76;
const FRAME_W = 1432;
const FRAME_H = Math.round((FRAME_W * 9) / 16);
const RIGHT = 1920 - FRAME_X - FRAME_W;
const CAPTION_Y = FRAME_Y + FRAME_H + 26;
const TAPE_Y = CAPTION_Y + 74;

const within = (t: number | null, a: number, b: number) => t != null && t >= a && t <= b;
const fade = (t: number, a: number, b: number, f = 0.18) => Math.max(0, Math.min(1, (t - a) / f, (b - t) / f));
const tc = (s: number) => {
	const m = Math.floor(s / 60);
	return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

function Chip({ status, children }: { status: string; children: React.ReactNode }) {
	const color = STATUS[status] ?? C.muted;
	return (
		<span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, letterSpacing: 1, textTransform: "uppercase", color, border: `1px solid ${color}66`, borderRadius: 4, padding: "2px 7px" }}>
			{children}
		</span>
	);
}

function Cursor({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
	const s = 1.3 / Math.sqrt(scale);
	return (
		<svg width={32} height={32} viewBox="0 0 32 32" style={{ position: "absolute", left: x, top: y, transform: `translate(-6px,-4px) scale(${s})`, transformOrigin: "6px 4px", opacity, filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))" }}>
			<path d="M6 4 L6 26 L12 20 L16 29 L20 27 L16 18 L24 18 Z" fill="#fff" stroke={C.ink} strokeWidth={1.6} strokeLinejoin="round" />
		</svg>
	);
}

function Ring({ x, y, age }: { x: number; y: number; age: number }) {
	const r = interpolate(age, [0, 0.45], [4, 34], { extrapolateRight: "clamp" });
	const o = interpolate(age, [0, 0.45], [0.9, 0], { extrapolateRight: "clamp" });
	return <div style={{ position: "absolute", left: x - r, top: y - r, width: 2 * r, height: 2 * r, borderRadius: "50%", border: "2.5px solid #fff", boxShadow: `0 0 0 1px ${C.ink}55`, opacity: o }} />;
}

export const Polished: React.FC<PolishedProps> = ({ video, title, timeline: tl }) => {
	const frame = useCurrentFrame();
	const { t, segment } = sourceTimeAt(tl, frame);
	const tSrc = t ?? tl.sourceDuration;

	// Criterion state at this moment: pending -> checking -> its final status.
	const rows = tl.end.criteria.map((c) => {
		const card = tl.cards.find((k) => k.id === c.id);
		const mark = tl.marks.find((m) => m.id === c.id);
		const state = mark && tSrc >= mark.start ? c.status : card && tSrc >= card.start ? "running" : "pending";
		return { ...c, state, start: card?.start, end: mark?.start };
	});
	const meta = [tl.meta.sha, tl.meta.label].filter(Boolean).join(" · ");

	const header = (
		<>
			<div style={{ position: "absolute", left: RAIL_X, top: HEADER_Y, fontFamily: MONO, fontSize: 18, fontWeight: 500, color: C.paper, letterSpacing: 0.5 }}>witness</div>
			<div style={{ position: "absolute", left: FRAME_X, top: HEADER_Y - 3, width: FRAME_W - 300, fontFamily: SANS, fontSize: 24, fontWeight: 500, color: C.paper, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
			<div style={{ position: "absolute", right: RIGHT, top: HEADER_Y, fontFamily: MONO, fontSize: 18, color: C.muted }}>{meta}</div>
		</>
	);

	if (segment.kind === "end") {
		const age = (frame - segment.from) / tl.fps;
		const color = STATUS[tl.end.overall] ?? C.muted;
		const appear = (d: number) => ({ opacity: interpolate(age, [d, d + 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) });
		return (
			<AbsoluteFill style={{ background: C.ink }}>
				{header}
				<div style={{ position: "absolute", left: FRAME_X, top: 230, width: FRAME_W }}>
					<div style={{ fontFamily: MONO, fontSize: 18, color: C.muted, letterSpacing: 1.5, ...appear(0) }}>VERDICT</div>
					<div style={{ fontFamily: SANS, fontSize: 132, fontWeight: 600, color, lineHeight: 1.05, marginTop: 8, ...appear(0.05) }}>{tl.end.overall.charAt(0).toUpperCase() + tl.end.overall.slice(1)}</div>
					<div style={{ marginTop: 56, borderTop: `1px solid ${C.hairline}` }}>
						{tl.end.criteria.map((c, i) => (
							<div key={c.id} style={{ display: "grid", gridTemplateColumns: "72px 130px 1fr", alignItems: "center", padding: "18px 0", borderBottom: `1px solid ${C.hairline}`, ...appear(0.25 + i * 0.1) }}>
								<span style={{ fontFamily: MONO, fontSize: 20, color: C.muted }}>{c.id}</span>
								<span>
									<Chip status={c.status}>{c.status}</Chip>
								</span>
								<span style={{ fontFamily: SANS, fontSize: 26, color: C.paper }}>{c.description}</span>
							</div>
						))}
					</div>
				</div>
			</AbsoluteFill>
		);
	}

	const base = FRAME_W / tl.screen.w;
	const z = t == null ? { scale: 1, cx: tl.screen.w / 2, cy: tl.screen.h / 2 } : zoomAt(tl.zoom, t);
	const k = base * z.scale;
	const layer = `translate(${FRAME_W / 2 - z.cx * k}px, ${FRAME_H / 2 - z.cy * k}px) scale(${k})`;
	const cur = t == null ? null : cursorAt(tl.cursor, t);
	const vis = t == null ? 0 : Math.max(0, ...tl.cursorVisible.map(([a, b]) => fade(t, a, b, 0.25)));
	const caption = t == null || segment.kind !== "video" ? undefined : tl.captions.find((c) => within(t, c.start, c.end));
	const freeze = segment.kind === "freeze" ? segment : null;
	const freezeAge = freeze ? (frame - freeze.from) / tl.fps : 0;
	const tapeX = (s: number) => (Math.max(0, Math.min(s, tl.sourceDuration)) / tl.sourceDuration) * FRAME_W;

	return (
		<AbsoluteFill style={{ background: C.ink }}>
			{header}

			{/* Criteria rail */}
			<div style={{ position: "absolute", left: RAIL_X, top: FRAME_Y, width: RAIL_W }}>
				<div style={{ fontFamily: MONO, fontSize: 15, color: C.muted, letterSpacing: 1.5, paddingBottom: 14, borderBottom: `1px solid ${C.hairline}` }}>CRITERIA</div>
				{rows.map((r) => {
					const active = r.state === "running";
					const done = r.state !== "running" && r.state !== "pending";
					return (
						<div key={r.id} style={{ padding: "16px 0 16px 14px", borderBottom: `1px solid ${C.hairline}`, borderLeft: `2px solid ${active ? C.paper : "transparent"}`, marginLeft: -16 }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
								<span style={{ fontFamily: MONO, fontSize: 16, color: active || done ? C.paper : C.faint }}>{r.id}</span>
								{done ? <Chip status={r.state}>{r.state}</Chip> : <span style={{ fontFamily: MONO, fontSize: 13, letterSpacing: 1, color: active ? C.muted : C.faint }}>{active ? "CHECKING" : "PENDING"}</span>}
							</div>
							<div style={{ fontFamily: SANS, fontSize: 18, lineHeight: 1.35, color: active ? C.paper : done ? C.muted : C.faint, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.description}</div>
						</div>
					);
				})}
			</div>

			{/* App frame */}
			<div style={{ position: "absolute", left: FRAME_X, top: FRAME_Y, width: FRAME_W, height: FRAME_H, borderRadius: 8, overflow: "hidden", background: C.surface, boxShadow: freeze ? `0 0 0 1px ${C.fail}, 0 0 0 3px ${C.fail}55` : `0 0 0 1px ${C.hairline}` }}>
				<div style={{ position: "absolute", left: 0, top: 0, width: tl.screen.w, height: tl.screen.h, transformOrigin: "0 0", transform: layer }}>
					{tl.segments.map((s) =>
						s.kind === "video" ? (
							<Sequence key={s.from} from={s.from} durationInFrames={s.frames} layout="none">
								<OffthreadVideo src={staticFile(video)} trimBefore={Math.round(s.srcStart * tl.fps)} playbackRate={s.rate} muted style={{ position: "absolute", width: tl.screen.w, height: tl.screen.h }} />
							</Sequence>
						) : null
					)}
					{freeze?.image ? <Img src={staticFile(freeze.image)} style={{ position: "absolute", width: tl.screen.w, height: tl.screen.h }} /> : null}
					{t != null && segment.kind === "video" ? tl.clicks.filter((c) => t >= c.t && t - c.t < 0.45).map((c) => <Ring key={c.t} x={c.x} y={c.y} age={t - c.t} />) : null}
					{cur && vis > 0 && !freeze ? <Cursor x={cur.x} y={cur.y} scale={z.scale} opacity={vis} /> : null}
				</div>
				{segment.kind === "video" && segment.fast ? (
					<div style={{ position: "absolute", right: 16, top: 14, fontFamily: MONO, fontSize: 16, color: C.paper, background: `${C.ink}d9`, border: `1px solid ${C.hairline}`, borderRadius: 4, padding: "3px 8px" }}>×{Math.round(segment.rate)}</div>
				) : null}
				{freeze ? (
					<div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "18px 24px", background: `${C.ink}eb`, borderTop: `1px solid ${C.fail}`, opacity: interpolate(freezeAge, [0, 0.2], [0, 1], { extrapolateRight: "clamp" }) }}>
						<div style={{ fontFamily: MONO, fontSize: 15, letterSpacing: 1.5, color: C.fail }}>FAIL · {freeze.criterion}</div>
						<div style={{ fontFamily: SANS, fontSize: 24, color: C.paper, marginTop: 6, lineHeight: 1.35 }}>{freeze.explanation}</div>
					</div>
				) : null}
			</div>

			{/* Caption + timecode */}
			<div style={{ position: "absolute", left: FRAME_X, top: CAPTION_Y, width: FRAME_W - 260, fontFamily: SANS, fontSize: 30, fontWeight: 500, color: C.paper, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: caption && t != null ? fade(t, caption.start, caption.end, 0.15) : 0 }}>{caption?.text}</div>
			<div style={{ position: "absolute", right: RIGHT, top: CAPTION_Y + 6, fontFamily: MONO, fontSize: 20, color: C.muted }}>
				{tc(tSrc)} <span style={{ color: C.faint }}>/ {tc(tl.sourceDuration)}</span>
			</div>

			{/* Evidence tape: criterion segments in source time, coloured once judged */}
			<div style={{ position: "absolute", left: FRAME_X, top: TAPE_Y, width: FRAME_W, height: 6, background: C.surface, borderRadius: 3 }}>
				{rows.map((r) => {
					if (r.start == null) return null;
					const a = tapeX(r.start);
					const b = tapeX(r.end ?? tl.sourceDuration);
					const judged = r.state !== "running" && r.state !== "pending";
					const reached = Math.max(0, Math.min(b, tapeX(tSrc)) - a);
					return (
						<div key={r.id} style={{ position: "absolute", left: a, top: 0, height: 6, width: Math.max(2, b - a - 3), background: C.hairline, borderRadius: 3, overflow: "hidden" }}>
							<div style={{ width: judged ? "100%" : reached, height: 6, background: judged ? (STATUS[r.state] ?? C.muted) : C.muted }} />
						</div>
					);
				})}
				<div style={{ position: "absolute", left: tapeX(tSrc) - 1, top: -5, width: 2, height: 16, background: C.paper, borderRadius: 1 }} />
			</div>
			<div style={{ position: "absolute", left: FRAME_X, top: TAPE_Y + 18, width: FRAME_W, height: 20 }}>
				{rows.map((r) => (r.start == null ? null : <span key={r.id} style={{ position: "absolute", left: tapeX(r.start), fontFamily: MONO, fontSize: 14, color: r.state === "pending" ? C.faint : C.muted }}>{r.id}</span>))}
			</div>
		</AbsoluteFill>
	);
};
