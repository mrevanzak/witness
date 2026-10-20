import { Composition } from "remotion";
import { Polished, type PolishedProps } from "./polished";

const placeholder: PolishedProps = {
	video: "computer/raw.mp4",
	title: "",
	timeline: {
		fps: 30,
		screen: { w: 1920, h: 1080 },
		durationInFrames: 90,
		sourceDuration: 3,
		segments: [{ kind: "end", from: 0, frames: 90 }],
		zoom: [],
		cursor: [],
		clicks: [],
		cursorVisible: [],
		captions: [],
		cards: [],
		marks: [],
		end: { overall: "blocked", title: "", criteria: [] },
		meta: { sha: "" },
	},
};

export const Root: React.FC = () => (
	<Composition
		id="Polished"
		component={Polished}
		width={1920}
		height={1080}
		fps={30}
		durationInFrames={90}
		defaultProps={placeholder}
		calculateMetadata={({ props }) => ({ durationInFrames: props.timeline.durationInFrames, fps: props.timeline.fps })}
	/>
);
