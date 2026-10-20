// A finished run's folder: the file names every package agrees on, and reading
// them back. A before/after run keeps the base commit's run in `<run>/before/`.
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import {
	type BlockedVerdict,
	parseSteps,
	ReportStill,
	RunInfo,
	Verdict,
	VerdictFile,
	WalkthroughReport,
} from "./run.ts"

export const RUN_FILES = {
	captions: "captions.vtt",
	/** Where an open session's command endpoint listens. */
	driver: "driver.json",
	gif: "preview.gif",
	hostedSection: "hosted-section.md",
	info: "run.json",
	plan: "plan.json",
	polished: "polished.mp4",
	raw: "computer/raw.mp4",
	report: "report.md",
	steps: "steps.jsonl",
	verdict: "verdict.json",
	walkthrough: "walkthrough.json",
} as const

/** The run of the base commit sits inside the change's run, under this name. */
export const BEFORE_DIR = "before"

/** A run file is missing or does not decode. */
export class RunFileError extends Schema.TaggedError<RunFileError>()("RunFileError", {
	file: Schema.String,
	message: Schema.String,
}) {}

/** `<dir>/<name>` decoded with `schema`; `None` when the file does not exist. */
export const readRunFile = <A, I>(dir: string, name: string, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(dir, name)
		const fail = (e: { readonly message: string }) => new RunFileError({ file, message: e.message })
		if (!(yield* fs.exists(file).pipe(Effect.mapError(fail)))) {
			return Option.none<A>()
		}
		const text = yield* fs.readFileString(file).pipe(Effect.mapError(fail))
		return Option.some(
			yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(fail))
		)
	})

/** Like `readRunFile`, for a file the run must have. */
export const requireRunFile = <A, I>(dir: string, name: string, schema: Schema.Codec<A, I>) =>
	readRunFile(dir, name, schema).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new RunFileError({ file: `${dir}/${name}`, message: `${dir} has no ${name} (is the run finished?)` })
					),
				onSome: Effect.succeed,
			})
		)
	)

/** The run's steps.jsonl, sorted by time (empty when it has none). */
export const readSteps = Effect.fnUntraced(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(dir, RUN_FILES.steps)
	const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
	return yield* parseSteps(text).pipe(Effect.mapError((e) => new RunFileError({ file, message: e.message })))
})

/** What a report, a render or an upload reads from a finished run. */
export type LoadedRun = {
	readonly dir: string
	readonly info: RunInfo
	readonly result: VerdictFile
	readonly walk: Option.Option<WalkthroughReport>
	/** Rendered media that exist, as file names in `dir`. */
	readonly media: {
		readonly polished: Option.Option<string>
		readonly gif: Option.Option<string>
		readonly captions: Option.Option<string>
	}
}

export const loadRun = Effect.fn("loadRun")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const [info, result, walk] = yield* Effect.all([
		requireRunFile(dir, RUN_FILES.info, RunInfo),
		requireRunFile(dir, RUN_FILES.verdict, VerdictFile),
		readRunFile(dir, RUN_FILES.walkthrough, WalkthroughReport),
	])
	const media = (name: string) =>
		fs.exists(path.join(dir, name)).pipe(
			Effect.orElseSucceed(() => false),
			Effect.map((ok) => (ok ? Option.some(name) : Option.none()))
		)
	return {
		dir,
		info,
		media: {
			captions: yield* media(RUN_FILES.captions),
			gif: yield* media(RUN_FILES.gif),
			polished: yield* media(RUN_FILES.polished),
		},
		result,
		walk,
	} satisfies LoadedRun
})

export const isVerdict = (v: VerdictFile): v is Verdict => v instanceof Verdict

/** A run and, when it recorded one, the base commit's run to show next to it. */
export type RunPair = {
	readonly after: LoadedRun
	/** Present only when the base commit reached a verdict. */
	readonly before: Option.Option<LoadedRun>
	/** Why there is no before, when the base commit was tried and blocked. */
	readonly notes: readonly string[]
}

const blockedNote = (b: BlockedVerdict) =>
	`The base commit could not be checked, so there is no before state: ${b.notes}`

/** Pairs `after` with the run in `beforeDir`, unless that one never reached a verdict (then a note says why). */
const pairWith = Effect.fnUntraced(function* (after: LoadedRun, beforeDir: string) {
	const result = yield* requireRunFile(beforeDir, RUN_FILES.verdict, VerdictFile)
	if (!isVerdict(result)) {
		return { after, before: Option.none(), notes: [blockedNote(result)] } satisfies RunPair
	}
	return { after, before: Option.some(yield* loadRun(beforeDir)), notes: [] } satisfies RunPair
})

/** A run with the before run it recorded inside it (`states: before-after`), if any. */
export const loadRunPair = Effect.fn("loadRunPair")(function* (runDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const beforeDir = path.join(runDir, BEFORE_DIR)
	const after = yield* loadRun(runDir)
	const hasBefore = yield* fs.exists(path.join(beforeDir, RUN_FILES.verdict)).pipe(Effect.orElseSucceed(() => false))
	return hasBefore ? yield* pairWith(after, beforeDir) : ({ after, before: Option.none(), notes: [] } satisfies RunPair)
})

/** Two runs made separately (two branches, say), as a before/after. */
export const pairRuns = Effect.fn("pairRuns")(function* (beforeDir: string, afterDir: string) {
	return yield* pairWith(yield* loadRun(afterDir), beforeDir)
})

/** The runs of a pair in the order they happened, labelled for headers and file names. */
export const pairSides = (
	pair: RunPair
): ReadonlyArray<{ readonly label: "before" | "after" | "run"; readonly run: LoadedRun }> =>
	Option.match(pair.before, {
		onNone: () => [{ label: "run", run: pair.after }],
		onSome: (before) => [
			{ label: "before", run: before },
			{ label: "after", run: pair.after },
		],
	})

/**
 * The stills a report shows for a run: the walkthrough's, else each criterion's
 * final screenshot. `key` pairs a before still with its after. Pure.
 */
export const evidenceStills = (run: LoadedRun): readonly ReportStill[] =>
	Option.match(run.walk, {
		onNone: () =>
			isVerdict(run.result)
				? run.result.criteria.flatMap((c) =>
						Option.match(c.screenshot, {
							onNone: () => [],
							onSome: (file) => [
								new ReportStill({
									caption: `${c.id} ${c.status}: ${c.explanation}`,
									file,
									key: c.id,
									...Option.match(c.video_ts, { onNone: () => ({}), onSome: ([, end]) => ({ t: end }) }),
								}),
							],
						})
					)
				: [],
		onSome: (w) =>
			w.stills.map(
				(s) =>
					new ReportStill({
						caption: s.caption,
						file: s.file,
						key: (s.file.split("/").at(-1) ?? s.file).replace(/^\d+-/, ""),
						...(s.t === undefined ? {} : { t: s.t }),
					})
			),
	})
