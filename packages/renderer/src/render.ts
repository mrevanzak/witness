// Renders <run>/polished.mp4 (Remotion) and preview.gif (ffmpeg) from a finished
// run: computer/raw.mp4, steps.jsonl, verdict.json, run.json. What was rendered
// (layout, and where each criterion's check lands in the video) goes to
// render/rendered.json for `witness upload`.

import { fileURLToPath } from "node:url"
import { bundle } from "@remotion/bundler"
import { renderMedia, selectComposition } from "@remotion/renderer"
import {
	EvidenceDestination,
	messageOf,
	RUN_FILES,
	RunInfo,
	readRunFile,
	readSteps,
	reportTitle,
	requireRunFile,
	Verdict,
} from "@witness/domain"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	buildTimeline,
	captionCues,
	LAYOUTS,
	type Layout,
	type PolishedProps,
	seekOf,
	type Timeline,
	webVtt,
} from "./timeline.ts"

export type { Layout } from "./timeline.ts"

/** A render step (Remotion, ffmpeg, ffprobe) failed or the run is incomplete. */
export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
	message: Schema.String,
}) {}

/** What polished.mp4 is rendered with: its layout, and whether the camera and cursor move. */
export type RenderSettings = { readonly animate: boolean; readonly layout: Layout }

/** What polished.mp4 was rendered as (render/rendered.json). */
export const RenderedCut = Schema.Struct({
	animate: Schema.Boolean,
	durationSec: Schema.Finite,
	layout: EvidenceDestination,
	/** Per criterion: [start, end] seconds in polished.mp4 where its check is shown. */
	seek: Schema.Record(Schema.String, Schema.Tuple([Schema.Finite, Schema.Finite])),
})
export type RenderedCut = typeof RenderedCut.Type
const RenderedCutJson = Schema.fromJsonString(RenderedCut)

export type RenderResult = RenderedCut & {
	readonly captions: Option.Option<string>
	readonly gif: string
	readonly polished: string
	readonly timeline: Timeline
}

const failed = (what: string) => (e: { readonly message: string }) =>
	new RenderError({ message: `${what}: ${e.message}` })

/** What polished.mp4 was last rendered as; none if it was never rendered (or by a witness that did not record it). */
export const readRenderedCut = Effect.fn("readRenderedCut")(function* (runDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(runDir, "render", "rendered.json")
	if (!(yield* fs.exists(file).pipe(Effect.mapError(failed("render/rendered.json"))))) {
		return Option.none<RenderedCut>()
	}
	return yield* fs
		.readFileString(file)
		.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(RenderedCutJson)),
			Effect.map(Option.some),
			Effect.mapError(failed("render/rendered.json"))
		)
})

// src/ here, dist/bin in the bundled CLI: ../remotion sits next to either (apps/cli/scripts/build.ts).
const ENTRY = fileURLToPath(new URL("../remotion/index.ts", import.meta.url))

const probeDuration = Effect.fnUntraced(function* (file: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const out = yield* spawner
		.string(ChildProcess.make("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]))
		.pipe(Effect.mapError(failed("ffprobe")))
	return Number.parseFloat(out.trim())
})

/** The composition's props for a finished run (pure timeline math over its decoded artifacts). */
const propsForRun = Effect.fnUntraced(function* (
	runDir: string,
	sourceDuration: number,
	settings: RenderSettings,
	label: string | undefined
) {
	const steps = yield* readSteps(runDir).pipe(Effect.mapError(failed(RUN_FILES.steps)))
	const verdict = yield* requireRunFile(runDir, RUN_FILES.verdict, Verdict).pipe(
		Effect.mapError(failed(RUN_FILES.verdict))
	)
	const info = yield* readRunFile(runDir, RUN_FILES.info, RunInfo).pipe(Effect.mapError(failed(RUN_FILES.info)))
	const task = Option.match(info, { onNone: () => "Verification", onSome: (i) => i.task })
	const timeline = buildTimeline({
		criteria: verdict.criteria.map((c) => ({ ...c, screenshot: Option.getOrNull(c.screenshot) })),
		meta: {
			sha: Option.match(info, { onNone: () => "", onSome: (i) => i.sha.slice(0, 7) }),
			...(label ? { label } : {}),
		},
		options: { animate: settings.animate, endCardSec: LAYOUTS[settings.layout].endCardSec },
		overall: verdict.overall,
		sourceDuration,
		steps: steps.flatMap((s) => (s.t === undefined ? [] : [{ ...s, t: s.t }])),
	})
	const props: PolishedProps = {
		layout: settings.layout,
		timeline,
		title: reportTitle(task).slice(0, 110),
		video: "computer/raw.mp4",
	}
	return {
		props,
		seek: seekOf(
			timeline,
			verdict.criteria.map((c) => ({ id: c.id, video_ts: Option.getOrNull(c.video_ts) }))
		),
	}
})

/** Bundles the composition (with the run dir as its public dir) and renders polished.mp4 with Remotion. */
const remotionRender = (runDir: string, props: PolishedProps, out: string) =>
	Effect.tryPromise({
		catch: (e) => new RenderError({ message: `remotion: ${messageOf(e)}` }),
		try: async () => {
			const serveUrl = await bundle({ entryPoint: ENTRY, publicDir: runDir })
			const composition = await selectComposition({ id: "Polished", inputProps: props, serveUrl })
			await renderMedia({
				codec: "h264",
				composition,
				concurrency: 4,
				crf: 20,
				inputProps: props,
				logLevel: "warn",
				outputLocation: out,
				serveUrl,
			})
		},
	})

export const renderRun = Effect.fn("renderRun")(function* (
	runDirIn: string,
	opts: { readonly animate?: boolean; readonly label?: string; readonly layout?: Layout } = {}
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const runDir = path.resolve(runDirIn)
	const raw = path.join(runDir, "computer", "raw.mp4")
	if (!(yield* fs.exists(raw))) {
		return yield* new RenderError({ message: `no recording at ${raw}` })
	}
	const settings: RenderSettings = { animate: opts.animate ?? true, layout: opts.layout ?? "pr" }
	const spec = LAYOUTS[settings.layout]
	const { props, seek } = yield* propsForRun(runDir, yield* probeDuration(raw), settings, opts.label)
	const { timeline } = props

	const outDir = path.join(runDir, "render")
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(path.join(outDir, "props.json"), JSON.stringify(props))
	const polished = path.join(runDir, "polished.mp4")
	yield* remotionRender(runDir, props, polished)

	// 10 s preview: starting shortly before the first failing moment, else at the start.
	const firstFreeze = timeline.segments.find((s) => s.kind === "freeze")
	const total = timeline.durationInFrames / timeline.fps
	const start = Math.max(0, Math.min((firstFreeze ? firstFreeze.from / timeline.fps : 0) - 6, total - 10))
	const gif = path.join(runDir, "preview.gif")
	yield* spawner
		.string(
			ChildProcess.make("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				start.toFixed(2),
				"-t",
				"10",
				"-i",
				polished,
				"-vf",
				"fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
				gif,
			])
		)
		.pipe(Effect.mapError(failed("preview.gif")))

	const vtt = path.join(runDir, "captions.vtt")
	if (spec.captions === "vtt") {
		yield* fs.writeFileString(vtt, webVtt(captionCues(timeline))).pipe(Effect.mapError(failed("captions.vtt")))
	} else {
		yield* fs.remove(vtt, { force: true }).pipe(Effect.mapError(failed("captions.vtt")))
	}

	const cut: RenderedCut = { ...settings, durationSec: yield* probeDuration(polished), seek }
	yield* Schema.encodeEffect(RenderedCutJson)(cut).pipe(
		Effect.flatMap((json) => fs.writeFileString(path.join(outDir, "rendered.json"), json)),
		Effect.mapError(failed("render/rendered.json"))
	)
	return {
		...cut,
		captions: spec.captions === "vtt" ? Option.some(vtt) : Option.none(),
		gif,
		polished,
		timeline,
	} satisfies RenderResult
})
