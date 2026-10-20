// Witness walkthrough video, framed by LAYOUTS (src/timeline.ts). PR: the recorded
// app in a hairline frame, the criteria checklist filling in on the left, the
// current action captioned under the frame, the evidence tape (criterion segments
// + playhead, in source time) below it, and a verdict card at the end. Hosted: the
// app fills the frame; the report page carries the criteria, and captions ship as
// a separate track. Driven by a precomputed Timeline.
import { AbsoluteFill, useCurrentFrame } from "remotion"
import { criterionStatesAt, LAYOUTS, type PolishedProps, sourceTimeAt } from "../src/timeline"
import { AppFrame } from "./app-frame"
import { Caption, Header, Rail, Tape, Timecode } from "./chrome"
import { EndCard } from "./end-card"
import { C } from "./theme"

export type { PolishedProps } from "../src/timeline"

export const Polished: React.FC<PolishedProps> = ({ video, title, timeline: tl, layout }) => {
	const frame = useCurrentFrame()
	const spec = LAYOUTS[layout]
	const { t, segment } = sourceTimeAt(tl, frame)
	if (segment.kind === "end") {
		return <EndCard age={(frame - segment.from) / tl.fps} title={title} tl={tl} />
	}
	const app = <AppFrame frame={frame} segment={segment} spec={spec} t={t} tl={tl} video={video} />
	if (!spec.chrome) {
		return <AbsoluteFill style={{ background: C.ink }}>{app}</AbsoluteFill>
	}
	const at = t ?? tl.sourceDuration
	const rows = criterionStatesAt(tl, at)
	return (
		<AbsoluteFill style={{ background: C.ink }}>
			<Header meta={tl.meta} title={title} />
			<Rail rows={rows} />
			{app}
			{spec.captions === "burned" ? <Caption segment={segment} t={t} tl={tl} /> : null}
			<Timecode at={at} total={tl.sourceDuration} />
			<Tape at={at} rows={rows} tl={tl} />
		</AbsoluteFill>
	)
}
