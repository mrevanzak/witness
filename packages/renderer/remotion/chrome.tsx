// The PR layout around the app frame: header, criteria rail, caption, timecode and evidence tape.
import type { CriterionState, Segment, Timeline } from "../src/timeline"
import { Chip } from "./primitives"
import {
	C,
	CAPTION_Y,
	FRAME,
	fade,
	HEADER_Y,
	MONO,
	RAIL_W,
	RAIL_X,
	RIGHT,
	SANS,
	STATUS,
	TAPE_Y,
	tc,
	within,
} from "./theme"

export function Header({ title, meta }: { title: string; meta: Timeline["meta"] }) {
	return (
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
					left: FRAME.x,
					overflow: "hidden",
					position: "absolute",
					textOverflow: "ellipsis",
					top: HEADER_Y - 3,
					whiteSpace: "nowrap",
					width: FRAME.w - 300,
				}}
			>
				{title}
			</div>
			<div
				style={{ color: C.muted, fontFamily: MONO, fontSize: 18, position: "absolute", right: RIGHT, top: HEADER_Y }}
			>
				{[meta.sha, meta.label].filter(Boolean).join(" · ")}
			</div>
		</>
	)
}

/** The criteria checklist: pending, checking, then each criterion's status. */
export function Rail({ rows }: { rows: CriterionState[] }) {
	return (
		<div style={{ left: RAIL_X, position: "absolute", top: FRAME.y, width: RAIL_W }}>
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
				let text = C.faint
				if (active) {
					text = C.paper
				} else if (r.judged) {
					text = C.muted
				}
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
							<span style={{ color: active || r.judged ? C.paper : C.faint, fontFamily: MONO, fontSize: 16 }}>
								{r.id}
							</span>
							{r.judged ? (
								<Chip status={r.state}>{r.state}</Chip>
							) : (
								<span style={{ color: active ? C.muted : C.faint, fontFamily: MONO, fontSize: 13, letterSpacing: 1 }}>
									{active ? "CHECKING" : "PENDING"}
								</span>
							)}
						</div>
						<div
							style={{
								color: text,
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
	)
}

/** The current action's label under the frame. */
export function Caption({ tl, t, segment }: { tl: Timeline; t: number | null; segment: Segment }) {
	const caption = t == null || segment.kind !== "video" ? undefined : tl.captions.find((c) => within(t, c.start, c.end))
	return (
		<div
			style={{
				color: C.paper,
				fontFamily: SANS,
				fontSize: 30,
				fontWeight: 500,
				left: FRAME.x,
				opacity: caption && t != null ? fade(t, caption.start, caption.end, 0.15) : 0,
				overflow: "hidden",
				position: "absolute",
				textOverflow: "ellipsis",
				top: CAPTION_Y,
				whiteSpace: "nowrap",
				width: FRAME.w - 260,
			}}
		>
			{caption?.text}
		</div>
	)
}

export function Timecode({ at, total }: { at: number; total: number }) {
	return (
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
			{tc(at)} <span style={{ color: C.faint }}>/ {tc(total)}</span>
		</div>
	)
}

/** The evidence tape: criterion segments in source time, coloured once judged, and the playhead. */
export function Tape({ rows, tl, at }: { rows: CriterionState[]; tl: Timeline; at: number }) {
	const x = (s: number) => (Math.max(0, Math.min(s, tl.sourceDuration)) / tl.sourceDuration) * FRAME.w
	return (
		<>
			<div
				style={{
					background: C.surface,
					borderRadius: 3,
					height: 6,
					left: FRAME.x,
					position: "absolute",
					top: TAPE_Y,
					width: FRAME.w,
				}}
			>
				{rows.map((r) => {
					if (r.begin === null) {
						return null
					}
					const a = x(r.begin)
					const b = x(r.end ?? tl.sourceDuration)
					const reached = Math.max(0, Math.min(b, x(at)) - a)
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
									background: r.judged ? STATUS[r.state] : C.muted,
									height: 6,
									width: r.judged ? "100%" : reached,
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
						left: x(at) - 1,
						position: "absolute",
						top: -5,
						width: 2,
					}}
				/>
			</div>
			<div style={{ height: 20, left: FRAME.x, position: "absolute", top: TAPE_Y + 18, width: FRAME.w }}>
				{rows.map((r) =>
					r.begin === null ? null : (
						<span
							key={r.id}
							style={{
								color: r.state === "pending" ? C.faint : C.muted,
								fontFamily: MONO,
								fontSize: 14,
								left: x(r.begin),
								position: "absolute",
							}}
						>
							{r.id}
						</span>
					)
				)}
			</div>
		</>
	)
}
