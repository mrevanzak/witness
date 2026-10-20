import { type CalculateMetadataFunction, Composition } from "remotion"
import { Polished, type PolishedProps } from "./polished"

const placeholder: PolishedProps = {
	layout: "pr",
	timeline: {
		captions: [],
		clicks: [],
		criteria: [],
		cursor: [],
		cursorVisible: [],
		durationInFrames: 90,
		fps: 30,
		meta: { sha: "" },
		overall: "blocked",
		screen: { h: 1080, w: 1920 },
		segments: [{ frames: 90, from: 0, kind: "end" }],
		sourceDuration: 3,
		zoom: [],
	},
	title: "",
	video: "computer/raw.mp4",
}

const calculateMetadata: CalculateMetadataFunction<PolishedProps> = ({ props }) => ({
	durationInFrames: props.timeline.durationInFrames,
	fps: props.timeline.fps,
})

export const Root: React.FC = () => (
	<Composition
		calculateMetadata={calculateMetadata}
		component={Polished}
		defaultProps={placeholder}
		durationInFrames={90}
		fps={30}
		height={1080}
		id="Polished"
		width={1920}
	/>
)
