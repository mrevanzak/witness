// Renders <run>/polished.mp4 (Remotion) and preview.gif (ffmpeg) from a finished
// run: computer/raw.mp4, steps.jsonl, verdict.json, run.json.
import { RunInfo, Step, Verdict } from "@witness/domain"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createRequire } from "node:module"
import { buildTimeline, type Timeline, type TimelineOptions } from "./timeline.ts"

/** A render step (Remotion, ffmpeg, ffprobe) failed or the run is incomplete. */
export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
	message: Schema.String,
}) {}

export interface RenderResult {
	readonly polished: string
	readonly gif: string
	readonly timeline: Timeline
	readonly durationSec: number
}

const HERE = new URL(".", import.meta.url).pathname
const failed = (what: string) => (e: { readonly message: string }) => new RenderError({ message: `${what}: ${e.message}` })

const probeDuration = Effect.fnUntraced(function* (file: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const out = yield* spawner.string(ChildProcess.make("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).pipe(Effect.mapError(failed("ffprobe")))
	return Number.parseFloat(out.trim())
})

/** The timeline for a finished run (pure math over its decoded artifacts). */
export const timelineForRun = Effect.fn("timelineForRun")(function* (runDir: string, sourceDuration: number, options?: Partial<TimelineOptions>, label?: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const read = <A, I>(file: string, schema: Schema.Codec<A, I>) =>
		fs.readFileString(path.join(runDir, file)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))), Effect.mapError(failed(file)))
	const lines = (yield* fs.readFileString(path.join(runDir, "steps.jsonl")).pipe(Effect.mapError(failed("steps.jsonl")))).split("\n").filter(Boolean)
	const steps = yield* Effect.forEach(lines, (l) => Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(l).pipe(Effect.mapError(failed("steps.jsonl"))))
	const verdict = yield* read("verdict.json", Verdict)
	const info = yield* read("run.json", RunInfo).pipe(Effect.option)
	const task = Option.match(info, { onNone: () => "Verification", onSome: (i) => i.task })
	const title = (task.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 110)
	return buildTimeline({
		steps: steps.flatMap(({ status, ...s }) => (s.t === undefined ? [] : [{ ...s, t: s.t, ...(typeof status === "string" ? { status } : {}) }])),
		criteria: verdict.criteria.map((c) => ({ id: c.id, kind: c.kind, description: c.description, status: c.status, explanation: c.explanation, screenshot: Option.getOrNull(c.screenshot) })),
		overall: verdict.overall,
		title,
		sourceDuration,
		...(options ? { options } : {}),
		meta: { sha: Option.match(info, { onNone: () => "", onSome: (i) => i.sha.slice(0, 7) }), ...(label ? { label } : {}) },
	})
})

export const renderRun = Effect.fn("renderRun")(function* (runDirIn: string, opts: { readonly label?: string; readonly concurrency?: number; readonly onProgress?: (line: string) => Effect.Effect<void> } = {}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const runDir = path.resolve(runDirIn)
	const raw = path.join(runDir, "computer", "raw.mp4")
	if (!(yield* fs.exists(raw))) return yield* new RenderError({ message: `no recording at ${raw}` })
	const timeline = yield* timelineForRun(runDir, yield* probeDuration(raw), undefined, opts.label)

	const outDir = path.join(runDir, "render")
	yield* fs.makeDirectory(outDir, { recursive: true })
	const propsPath = path.join(outDir, "props.json")
	yield* fs.writeFileString(propsPath, JSON.stringify({ video: "computer/raw.mp4", title: timeline.end.title, timeline }))
	yield* fs.writeFileString(path.join(outDir, "timeline.json"), JSON.stringify(timeline, null, 1))

	const polished = path.join(runDir, "polished.mp4")
	const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@remotion/cli/package.json")), "remotion-cli.js")
	const args = [cli, "render", path.resolve(HERE, "../remotion/index.ts"), "Polished", polished, `--props=${propsPath}`, `--public-dir=${runDir}`, "--codec=h264", "--crf=20", `--concurrency=${opts.concurrency ?? 4}`, "--log=warn"]
	yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, args, { cwd: path.resolve(HERE, ".."), stdin: "ignore" }))
			const tail: Array<string> = []
			yield* handle.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) => {
					tail.push(line)
					if (tail.length > 40) tail.shift()
					return opts.onProgress ? opts.onProgress(line) : Effect.void
				})
			)
			const code = yield* handle.exitCode
			if (code !== ChildProcessSpawner.ExitCode(0)) return yield* new RenderError({ message: `remotion render exited ${code}:\n${tail.join("\n")}` })
		})
	).pipe(Effect.catchTag("PlatformError", (e) => Effect.fail(new RenderError({ message: `remotion: ${e.message}` }))))

	// 10 s preview: starting shortly before the first failing moment, else at the start.
	const firstFreeze = timeline.segments.find((s) => s.kind === "freeze")
	const total = timeline.durationInFrames / timeline.fps
	const start = Math.max(0, Math.min((firstFreeze ? firstFreeze.from / timeline.fps : 0) - 6, total - 10))
	const gif = path.join(runDir, "preview.gif")
	yield* spawner
		.string(
			ChildProcess.make("ffmpeg", [
				"-hide_banner", "-loglevel", "error", "-y",
				"-ss", start.toFixed(2), "-t", "10", "-i", polished,
				"-vf", "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
				gif,
			])
		)
		.pipe(Effect.mapError(failed("preview.gif")))
	return { polished, gif, timeline, durationSec: yield* probeDuration(polished) } satisfies RenderResult
})
