// Witness walkthrough video: the recorded app in a hairline frame, the criteria
// checklist filling in on the left, the current action captioned under the frame,
// and the evidence tape (criterion segments + playhead, in source time) below it.
// Driven by a precomputed Timeline (src/timeline.ts).
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono"
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans"
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion"
import { cursorAt, sourceTimeAt, type Timeline, zoomAt } from "../src/timeline"

export type PolishedProps = {
	timeline: Timeline
	title: string
	video: string
}

const { fontFamily: SANS } = loadSans("normal", { subsets: ["latin"], weights: ["400", "500", "600"] })
const { fontFamily: MONO } = loadMono("normal", { subsets: ["latin"], weights: ["400", "500"] })

const C = {
	blocked: "#E2A336",
	fail: "#F2555A",
	faint: "#4A4C50",
	hairline: "#2A2C30",
	ink: "#0E0F10",
	muted: "#8B8984",
	paper: "#E7E5E0",
	pass: "#4CC38A",
	surface: "#17181B",
}
const STATUS: Record<string, string> = { blocked: C.blocked, fail: C.fail, pass: C.pass }

// Layout (1920x1080): header, criteria rail, 16:9 app frame, caption row, tape.
const HEADER_Y = 30
const RAIL_X = 48
const RAIL_W = 344
const FRAME_X = 440
const FRAME_Y = 76
const FRAME_W = 1432
const FRAME_H = Math.round((FRAME_W * 9) / 16)
const RIGHT = 1920 - FRAME_X - FRAME_W
const CAPTION_Y = FRAME_Y + FRAME_H + 26
const TAPE_Y = CAPTION_Y + 74

const within = (t: number | null, a: number, b: number) => t != null && t >= a && t <= b
const fade = (t: number, a: number, b: number, f = 0.18) => Math.max(0, Math.min(1, (t - a) / f, (b - t) / f))
const tc = (s: number) => {
	const m = Math.floor(s / 60)
	return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`
}

function Chip({ status, children }: { status: string; children: React.ReactNode }) {
	const color = STATUS[status] ?? C.muted
	return (
		<span
			style={{
				border: `1px solid ${color}66`,
				borderRadius: 4,
				color,
				fontFamily: MONO,
				fontSize: 14,
				fontWeight: 500,
				letterSpacing: 1,
				padding: "2px 7px",
				textTransform: "uppercase",
			}}
		>
			{children}
		</span>
	)
}

function Cursor({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
	const s = 1.3 / Math.sqrt(scale)
	return (
		<svg
			height={32}
			style={{
				filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
				left: x,
				opacity,
				position: "absolute",
				top: y,
				transform: `translate(-6px,-4px) scale(${s})`,
				transformOrigin: "6px 4px",
			}}
			viewBox="0 0 32 32"
			width={32}
		>
			<path
				d="M6 4 L6 26 L12 20 L16 29 L20 27 L16 18 L24 18 Z"
				fill="#fff"
				stroke={C.ink}
				strokeLinejoin="round"
				strokeWidth={1.6}
			/>
		</svg>
	)
}

function Ring({ x, y, age }: { x: number; y: number; age: number }) {
	const r = interpolate(age, [0, 0.45], [4, 34], { extrapolateRight: "clamp" })
	const o = interpolate(age, [0, 0.45], [0.9, 0], { extrapolateRight: "clamp" })
	return (
		<div
			style={{
				border: "2.5px solid #fff",
				borderRadius: "50%",
				boxShadow: `0 0 0 1px ${C.ink}55`,
				height: 2 * r,
				left: x - r,
				opacity: o,
				position: "absolute",
				top: y - r,
				width: 2 * r,
			}}
		/>
	)
}

export const Polished: React.FC<PolishedProps> = ({ video, title, timeline: tl }) => {
	const frame = useCurrentFrame()
	const { t, segment } = sourceTimeAt(tl, frame)
	const tSrc = t ?? tl.sourceDuration

	// Criterion state at this moment: pending -> checking -> its final status.
	const rows = tl.end.criteria.map((c) => {
		const card = tl.cards.find((x) => x.id === c.id)
		const mark = tl.marks.find((m) => m.id === c.id)
		const state = mark && tSrc >= mark.start ? c.status : card && tSrc >= card.start ? "running" : "pending"
		return { ...c, end: mark?.start, start: card?.start, state }
	})
	const meta = [tl.meta.sha, tl.meta.label].filter(Boolean).join(" · ")

	const header = (
		<>
			<div
				style={{
					color: C.paper,
					fontFamily: MONO,
					fontSize: 18,
					fontWeight: 500,
					left: RAIL_X,
					letterSpacing: 0.5,
					position: "absolute",
					top: HEADER_Y,
				}}
			>
				witness
			</div>
			<div
				style={{
					color: C.paper,
					fontFamily: SANS,
					fontSize: 24,
					fontWeight: 500,
					left: FRAME_X,
					overflow: "hidden",
					position: "absolute",
					textOverflow: "ellipsis",
					top: HEADER_Y - 3,
					whiteSpace: "nowrap",
					width: FRAME_W - 300,
				}}
			>
				{title}
			</div>
			<div
				style={{ color: C.muted, fontFamily: MONO, fontSize: 18, position: "absolute", right: RIGHT, top: HEADER_Y }}
			>
				{meta}
			</div>
		</>
	)

	if (segment.kind === "end") {
		const age = (frame - segment.from) / tl.fps
		const color = STATUS[tl.end.overall] ?? C.muted
		const appear = (d: number) => ({
			opacity: interpolate(age, [d, d + 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
		})
		return (
			<AbsoluteFill style={{ background: C.ink }}>
				{header}
				<div style={{ left: FRAME_X, position: "absolute", top: 230, width: FRAME_W }}>
					<div style={{ color: C.muted, fontFamily: MONO, fontSize: 18, letterSpacing: 1.5, ...appear(0) }}>
						VERDICT
					</div>
					<div
						style={{
							color,
							fontFamily: SANS,
							fontSize: 132,
							fontWeight: 600,
							lineHeight: 1.05,
							marginTop: 8,
							...appear(0.05),
						}}
					>
						{tl.end.overall.charAt(0).toUpperCase() + tl.end.overall.slice(1)}
					</div>
					<div style={{ borderTop: `1px solid ${C.hairline}`, marginTop: 56 }}>
						{tl.end.criteria.map((c, i) => (
							<div
								key={c.id}
								style={{
									alignItems: "center",
									borderBottom: `1px solid ${C.hairline}`,
									display: "grid",
									gridTemplateColumns: "72px 130px 1fr",
									padding: "18px 0",
									...appear(0.25 + i * 0.1),
								}}
							>
								<span style={{ color: C.muted, fontFamily: MONO, fontSize: 20 }}>{c.id}</span>
								<span>
									<Chip status={c.status}>{c.status}</Chip>
								</span>
								<span style={{ color: C.paper, fontFamily: SANS, fontSize: 26 }}>{c.description}</span>
							</div>
						))}
					</div>
				</div>
			</AbsoluteFill>
		)
	}

	const base = FRAME_W / tl.screen.w
	const z = t == null ? { cx: tl.screen.w / 2, cy: tl.screen.h / 2, scale: 1 } : zoomAt(tl.zoom, t)
	const k = base * z.scale
	const layer = `translate(${FRAME_W / 2 - z.cx * k}px, ${FRAME_H / 2 - z.cy * k}px) scale(${k})`
	const cur = t == null ? null : cursorAt(tl.cursor, t)
	const vis = t == null ? 0 : Math.max(0, ...tl.cursorVisible.map(([a, b]) => fade(t, a, b, 0.25)))
	const caption = t == null || segment.kind !== "video" ? undefined : tl.captions.find((c) => within(t, c.start, c.end))
	const freeze = segment.kind === "freeze" ? segment : null
	const freezeAge = freeze ? (frame - freeze.from) / tl.fps : 0
	const tapeX = (s: number) => (Math.max(0, Math.min(s, tl.sourceDuration)) / tl.sourceDuration) * FRAME_W

	return (
		<AbsoluteFill style={{ background: C.ink }}>
			{header}

			{/* Criteria rail */}
			<div style={{ left: RAIL_X, position: "absolute", top: FRAME_Y, width: RAIL_W }}>
				<div
					style={{
						borderBottom: `1px solid ${C.hairline}`,
						color: C.muted,
						fontFamily: MONO,
						fontSize: 15,
						letterSpacing: 1.5,
						paddingBottom: 14,
					}}
				>
					CRITERIA
				</div>
				{rows.map((r) => {
					const active = r.state === "running"
					const done = r.state !== "running" && r.state !== "pending"
					return (
						<div
							key={r.id}
							style={{
								borderBottom: `1px solid ${C.hairline}`,
								borderLeft: `2px solid ${active ? C.paper : "transparent"}`,
								marginLeft: -16,
								padding: "16px 0 16px 14px",
							}}
						>
							<div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
								<span style={{ color: active || done ? C.paper : C.faint, fontFamily: MONO, fontSize: 16 }}>
									{r.id}
								</span>
								{done ? (
									<Chip status={r.state}>{r.state}</Chip>
								) : (
									<span style={{ color: active ? C.muted : C.faint, fontFamily: MONO, fontSize: 13, letterSpacing: 1 }}>
										{active ? "CHECKING" : "PENDING"}
									</span>
								)}
							</div>
							<div
								style={{
									color: active ? C.paper : done ? C.muted : C.faint,
									display: "-webkit-box",
									fontFamily: SANS,
									fontSize: 18,
									lineHeight: 1.35,
									overflow: "hidden",
									WebkitBoxOrient: "vertical",
									WebkitLineClamp: 3,
								}}
							>
								{r.description}
							</div>
						</div>
					)
				})}
			</div>

			{/* App frame */}
			<div
				style={{
					background: C.surface,
					borderRadius: 8,
					boxShadow: freeze ? `0 0 0 1px ${C.fail}, 0 0 0 3px ${C.fail}55` : `0 0 0 1px ${C.hairline}`,
					height: FRAME_H,
					left: FRAME_X,
					overflow: "hidden",
					position: "absolute",
					top: FRAME_Y,
					width: FRAME_W,
				}}
			>
				<div
					style={{
						height: tl.screen.h,
						left: 0,
						position: "absolute",
						top: 0,
						transform: layer,
						transformOrigin: "0 0",
						width: tl.screen.w,
					}}
				>
					{tl.segments.map((s) =>
						s.kind === "video" ? (
							<Sequence durationInFrames={s.frames} from={s.from} key={s.from} layout="none">
								<OffthreadVideo
									muted
									playbackRate={s.rate}
									src={staticFile(video)}
									style={{ height: tl.screen.h, position: "absolute", width: tl.screen.w }}
									trimBefore={Math.round(s.srcStart * tl.fps)}
								/>
							</Sequence>
						) : null
					)}
					{freeze?.image ? (
						<Img
							src={staticFile(freeze.image)}
							style={{ height: tl.screen.h, position: "absolute", width: tl.screen.w }}
						/>
					) : null}
					{t != null && segment.kind === "video"
						? tl.clicks
								.filter((c) => t >= c.t && t - c.t < 0.45)
								.map((c) => <Ring age={t - c.t} key={c.t} x={c.x} y={c.y} />)
						: null}
					{cur && vis > 0 && !freeze ? <Cursor opacity={vis} scale={z.scale} x={cur.x} y={cur.y} /> : null}
				</div>
				{segment.kind === "video" && segment.fast ? (
					<div
						style={{
							background: `${C.ink}d9`,
							border: `1px solid ${C.hairline}`,
							borderRadius: 4,
							color: C.paper,
							fontFamily: MONO,
							fontSize: 16,
							padding: "3px 8px",
							position: "absolute",
							right: 16,
							top: 14,
						}}
					>
						×{Math.round(segment.rate)}
					</div>
				) : null}
				{freeze ? (
					<div
						style={{
							background: `${C.ink}eb`,
							borderTop: `1px solid ${C.fail}`,
							bottom: 0,
							left: 0,
							opacity: interpolate(freezeAge, [0, 0.2], [0, 1], { extrapolateRight: "clamp" }),
							padding: "18px 24px",
							position: "absolute",
							right: 0,
						}}
					>
						<div style={{ color: C.fail, fontFamily: MONO, fontSize: 15, letterSpacing: 1.5 }}>
							FAIL · {freeze.criterion}
						</div>
						<div style={{ color: C.paper, fontFamily: SANS, fontSize: 24, lineHeight: 1.35, marginTop: 6 }}>
							{freeze.explanation}
						</div>
					</div>
				) : null}
			</div>

			{/* Caption + timecode */}
			<div
				style={{
					color: C.paper,
					fontFamily: SANS,
					fontSize: 30,
					fontWeight: 500,
					left: FRAME_X,
					opacity: caption && t != null ? fade(t, caption.start, caption.end, 0.15) : 0,
					overflow: "hidden",
					position: "absolute",
					textOverflow: "ellipsis",
					top: CAPTION_Y,
					whiteSpace: "nowrap",
					width: FRAME_W - 260,
				}}
			>
				{caption?.text}
			</div>
			<div
				style={{
					color: C.muted,
					fontFamily: MONO,
					fontSize: 20,
					position: "absolute",
					right: RIGHT,
					top: CAPTION_Y + 6,
				}}
			>
				{tc(tSrc)} <span style={{ color: C.faint }}>/ {tc(tl.sourceDuration)}</span>
			</div>

			{/* Evidence tape: criterion segments in source time, coloured once judged */}
			<div
				style={{
					background: C.surface,
					borderRadius: 3,
					height: 6,
					left: FRAME_X,
					position: "absolute",
					top: TAPE_Y,
					width: FRAME_W,
				}}
			>
				{rows.map((r) => {
					if (r.start == null) {
						return null
					}
					const a = tapeX(r.start)
					const b = tapeX(r.end ?? tl.sourceDuration)
					const judged = r.state !== "running" && r.state !== "pending"
					const reached = Math.max(0, Math.min(b, tapeX(tSrc)) - a)
					return (
						<div
							key={r.id}
							style={{
								background: C.hairline,
								borderRadius: 3,
								height: 6,
								left: a,
								overflow: "hidden",
								position: "absolute",
								top: 0,
								width: Math.max(2, b - a - 3),
							}}
						>
							<div
								style={{
									background: judged ? (STATUS[r.state] ?? C.muted) : C.muted,
									height: 6,
									width: judged ? "100%" : reached,
								}}
							/>
						</div>
					)
				})}
				<div
					style={{
						background: C.paper,
						borderRadius: 1,
						height: 16,
						left: tapeX(tSrc) - 1,
						position: "absolute",
						top: -5,
						width: 2,
					}}
				/>
			</div>
			<div style={{ height: 20, left: FRAME_X, position: "absolute", top: TAPE_Y + 18, width: FRAME_W }}>
				{rows.map((r) =>
					r.start == null ? null : (
						<span
							key={r.id}
							style={{
								color: r.state === "pending" ? C.faint : C.muted,
								fontFamily: MONO,
								fontSize: 14,
								left: tapeX(r.start),
								position: "absolute",
							}}
						>
							{r.id}
						</span>
					)
				)}
			</div>
		</AbsoluteFill>
	)
}
