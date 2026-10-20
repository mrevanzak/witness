import { type CalculateMetadataFunction, Composition } from "remotion"
import { Polished, type PolishedProps } from "./polished"

const placeholder: PolishedProps = {
	timeline: {
		captions: [],
		cards: [],
		clicks: [],
		cursor: [],
		cursorVisible: [],
		durationInFrames: 90,
		end: { criteria: [], overall: "blocked", title: "" },
		fps: 30,
		marks: [],
		meta: { sha: "" },
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
