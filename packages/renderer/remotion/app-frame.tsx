// The recorded app inside the frame: zoom and pan, cursor, ripples, speed badge, freeze note.
import { Img, interpolate, OffthreadVideo, Sequence, staticFile } from "remotion"
import { cursorAt, type LayoutSpec, PACING, type Segment, type Timeline, zoomAt } from "../src/timeline"
import { Cursor, Ring } from "./primitives"
import { C, fade, MONO, SANS } from "./theme"

/** The recorded app, zoomed and panned, with the cursor, click ripples, speed badge and freeze note. */
export function AppFrame({
	tl,
	spec,
	frame,
	t,
	segment,
	video,
}: {
	tl: Timeline
	spec: LayoutSpec
	frame: number
	t: number | null
	segment: Segment
	video: string
}) {
	const { frame: box, labelScale: u } = spec
	const base = box.w / tl.screen.w
	const z = t == null ? { cx: tl.screen.w / 2, cy: tl.screen.h / 2, scale: 1 } : zoomAt(tl.zoom, t)
	const k = base * z.scale
	const layer = `translate(${box.w / 2 - z.cx * k}px, ${box.h / 2 - z.cy * k}px) scale(${k})`
	const cur = t == null ? null : cursorAt(tl.cursor, t)
	const vis = t == null ? 0 : Math.max(0, ...tl.cursorVisible.map(([a, b]) => fade(t, a, b, 0.25)))
	const freeze = segment.kind === "freeze" ? segment : null
	const freezeAge = freeze ? (frame - freeze.from) / tl.fps : 0
	let outline = "none"
	if (spec.freezeBorder === "outer") {
		outline = freeze ? `0 0 0 1px ${C.fail}, 0 0 0 3px ${C.fail}55` : `0 0 0 1px ${C.hairline}`
	}
	return (
		<div
			style={{
				background: C.surface,
				borderRadius: box.radius,
				boxShadow: outline,
				height: box.h,
				left: box.x,
				overflow: "hidden",
				position: "absolute",
				top: box.y,
				width: box.w,
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
							.filter((c) => t >= c.t && t - c.t < PACING.cursor.glide)
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
						fontSize: 16 * u,
						padding: `${3 * u}px ${8 * u}px`,
						position: "absolute",
						right: 16 * u,
						top: 14 * u,
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
						padding: `${18 * u}px ${24 * u}px`,
						position: "absolute",
						right: 0,
					}}
				>
					<div style={{ color: C.fail, fontFamily: MONO, fontSize: 15 * u, letterSpacing: 1.5 }}>
						FAIL · {freeze.criterion}
					</div>
					<div style={{ color: C.paper, fontFamily: SANS, fontSize: 24 * u, lineHeight: 1.35, marginTop: 6 * u }}>
						{freeze.explanation}
					</div>
				</div>
			) : null}
			{spec.freezeBorder === "inner" && freeze ? (
				<div style={{ boxShadow: `inset 0 0 0 4px ${C.fail}`, inset: 0, position: "absolute" }} />
			) : null}
		</div>
	)
}
