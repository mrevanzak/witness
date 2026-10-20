// The verdict card at the end of the video.
import { AbsoluteFill, interpolate } from "remotion"
import type { Timeline } from "../src/timeline"
import { Header } from "./chrome"
import { Chip } from "./primitives"
import { C, FRAME, MONO, SANS, STATUS } from "./theme"

/** The verdict card: overall status, then each criterion fading in. */
export function EndCard({ tl, title, age }: { tl: Timeline; title: string; age: number }) {
	const appear = (d: number) => ({
		opacity: interpolate(age, [d, d + 0.35], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
	})
	return (
		<AbsoluteFill style={{ background: C.ink }}>
			<Header meta={tl.meta} title={title} />
			<div style={{ left: FRAME.x, position: "absolute", top: 230, width: FRAME.w }}>
				<div style={{ color: C.muted, fontFamily: MONO, fontSize: 18, letterSpacing: 1.5, ...appear(0) }}>VERDICT</div>
				<div
					style={{
						color: STATUS[tl.overall],
						fontFamily: SANS,
						fontSize: 132,
						fontWeight: 600,
						lineHeight: 1.05,
						marginTop: 8,
						...appear(0.05),
					}}
				>
					{tl.overall.charAt(0).toUpperCase() + tl.overall.slice(1)}
				</div>
				<div style={{ borderTop: `1px solid ${C.hairline}`, marginTop: 56 }}>
					{tl.criteria.map((c, i) => (
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
