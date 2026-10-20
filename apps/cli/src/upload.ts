// `witness upload`: publish a run (or a before/after pair) as a hosted report on
// the Witness Worker (R2 + D1) and print its unlisted URL.
// It also writes hosted-section.md in the (last) run dir: a short "## Manual
// verification" that links the page, ready for `witness publish --report`.
// Config: WITNESS_REPORTS_URL (the Worker's origin), WITNESS_UPLOAD_TOKEN.
import {
	ReportApi,
	ReportManifest,
	ReportSection,
	RunInfo,
	Still,
	UploadAuth,
	Verdict,
	WalkthroughReport,
} from "@witness/domain"
import { outputTimeOf, type RenderSettings, renderedSettings, renderOptions, timelineForRun } from "@witness/renderer"
import { Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** The run is missing something the report needs (verdict, rendered video). */
export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", { message: Schema.String }) {}

const readJson = <A, I>(file: string, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (!(yield* fs.exists(file))) {
			return Option.none<A>()
		}
		return Option.some(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(yield* fs.readFileString(file)))
	})

const ICON: Record<string, string> = { blocked: "⚠️", fail: "❌", pass: "✅" }
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")

/** The PR section for a hosted report: verdict, criteria and a link; media stay on the page. Pure. */
export const hostedSection = (m: ReportManifest, url: string): string => {
	const main = m.sections[0]!
	const out = ["## Manual verification"]
	if (m.preview) {
		out.push(`Preview: ${m.preview}`)
	}
	if (main.gif) {
		out.push(`[![Walkthrough preview](${url}/${main.gif})](${url})`)
	}
	// A before/after names each verdict; a single run doesn't need its "run" label.
	const many = m.sections.length > 1
	const verdicts = m.sections.map(
		(s) => `${many && s.label ? `${s.label}: ` : ""}${ICON[s.verdict.overall] ?? ""} **${s.verdict.overall}**`
	)
	out.push(`${verdicts.join(" · ")} · [Full report: video, stills and logs](${url})`)
	out.push(
		[
			"| Result | Criterion | Video | What was seen |",
			"|---|---|---|---|",
			...main.verdict.criteria.map((c) => {
				const at = main.seek[c.id]
				return `| ${ICON[c.status] ?? ""} ${c.status} | ${c.id}${c.kind === "regression" ? " (regression)" : ""} ${cell(c.description)} | ${at ? `${mmss(at[0])}–${mmss(at[1])}` : "–"} | ${cell(c.explanation)} |`
			}),
		].join("\n")
	)
	if (m.notes.length) {
		out.push(m.notes.map((n) => `- ${n}`).join("\n"))
	}
	return `${out.join("\n\n")}\n`
}

type Upload = {
	readonly name: string
	readonly path: string
}

/** One run as a report section plus the files it references. */
const sectionFor = Effect.fn("sectionFor")(function* (runDir: string, label: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const verdict = yield* readJson(path.join(runDir, "verdict.json"), Verdict)
	if (Option.isNone(verdict)) {
		return yield* new UploadError({ message: `${runDir} has no verdict.json (a finished run is needed)` })
	}
	const walk = yield* readJson(path.join(runDir, "walkthrough.json"), WalkthroughReport)
	const info = yield* readJson(path.join(runDir, "run.json"), RunInfo)
	const uploads: Upload[] = []
	const add = (file: string, name: string) => {
		uploads.push({ name, path: path.join(runDir, file) })
		return name
	}

	// Stills: the walkthrough's, else each criterion's final screenshot.
	const stills = Option.match(walk, {
		onNone: () =>
			verdict.value.criteria.flatMap((c) =>
				Option.match(c.screenshot, {
					onNone: () => [],
					onSome: (file) => [
						new Still({ at: 0, caption: `${c.id} ${c.status}: ${c.explanation}`, file: add(file, `${label}-${file}`) }),
					],
				})
			),
		onSome: (w) => w.stills.map((s) => new Still({ ...s, file: add(s.file, `${label}-${path.basename(s.file)}`) })),
	})

	// The polished video, and where each criterion is shown in it.
	const polished = path.join(runDir, "polished.mp4")
	let video: string | undefined
	let gif: string | undefined
	let captions: string | undefined
	const seek: Record<string, readonly [number, number]> = {}
	if (yield* fs.exists(polished)) {
		video = add("polished.mp4", `${label}-video.mp4`)
		if (yield* fs.exists(path.join(runDir, "preview.gif"))) {
			gif = add("preview.gif", `${label}-preview.gif`)
		}
		const settings = Option.getOrElse(
			yield* renderedSettings(runDir),
			(): RenderSettings => ({ animate: true, layout: "pr" })
		)
		if (settings.layout === "pr") {
			yield* Console.error(
				`warning: ${runDir} was rendered with the PR layout (criteria rail in the video, small on the page); re-render with \`witness render --layout hosted\``
			)
		} else if (yield* fs.exists(path.join(runDir, "captions.vtt"))) {
			captions = add("captions.vtt", `${label}-captions.vtt`)
		}
		const duration = Number(
			(yield* spawner.string(
				ChildProcess.make("ffprobe", [
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"csv=p=0",
					path.join(runDir, "computer", "raw.mp4"),
				])
			)).trim()
		)
		const timeline = yield* timelineForRun(runDir, duration, renderOptions(settings))
		for (const c of verdict.value.criteria) {
			if (Option.isNone(c.video_ts)) {
				continue
			}
			const [a, b] = c.video_ts.value
			const start = outputTimeOf(timeline, a)
			const end = outputTimeOf(timeline, b)
			if (start !== null) {
				seek[c.id] = [Math.round(start * 10) / 10, Math.round((end ?? start) * 10) / 10]
			}
		}
	}

	return {
		info,
		section: new ReportSection({
			label,
			sha: Option.match(info, { onNone: () => "", onSome: (i) => i.sha }),
			stills,
			verdict: verdict.value,
			...(video ? { video } : {}),
			...(gif ? { gif } : {}),
			...(captions ? { captions } : {}),
			seek,
		}),
		uploads,
		walk,
	}
})

export const upload = Effect.fn("upload")(function* (o: {
	readonly runs: ReadonlyArray<{ readonly dir: string; readonly label: string }>
	readonly title: Option.Option<string>
	readonly pr: Option.Option<string>
	readonly repo: Option.Option<string>
	readonly preview: Option.Option<string>
	readonly notes: readonly string[]
}) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const baseUrl = yield* Config.String("WITNESS_REPORTS_URL")
	const token = yield* Config.Redacted("WITNESS_UPLOAD_TOKEN")

	const parts = yield* Effect.forEach(o.runs, (r) => sectionFor(path.resolve(r.dir), r.label))
	// The verdict that counts is the last run's ("after" in a before/after).
	const main = parts.at(-1)!
	const firstLine = (s: string) => (s.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim()
	const title = Option.getOrElse(o.title, () =>
		Option.match(main.info, { onNone: () => "Verification", onSome: (i) => firstLine(i.task) || "Verification" })
	)
	const repo = Option.orElse(o.repo, () => Option.map(main.info, (i) => path.basename(i.repo)))
	const walkNotes = parts.flatMap((p) => Option.match(p.walk, { onNone: () => [], onSome: (w) => w.notes }))
	const manifest = new ReportManifest({
		title,
		...Option.match(repo, { onNone: () => ({}), onSome: (r) => ({ repo: r }) }),
		...Option.match(o.pr, { onNone: () => ({}), onSome: (pr) => ({ pr }) }),
		createdAt: new Date().toISOString(),
		intro: Option.match(main.walk, { onNone: () => "", onSome: (w) => w.intro }),
		notes: [...new Set([...walkNotes, ...o.notes])],
		overall: main.section.verdict.overall,
		preview: Option.getOrElse(o.preview, () => Option.match(main.walk, { onNone: () => "", onSome: (w) => w.preview })),
		sections: [...parts].reverse().map((p) => p.section),
	})

	const AuthClient = HttpApiMiddleware.layerClient(
		UploadAuth,
		Effect.fn(function* ({ next, request }) {
			return yield* next(HttpClientRequest.bearerToken(request, Redacted.value(token)))
		})
	)
	const client = yield* HttpApiClient.make(ReportApi, {
		transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
	}).pipe(Effect.provide(AuthClient))

	const created = yield* client.reports.create({ payload: manifest })
	yield* Console.error(`report ${created.id}: uploading ${parts.reduce((n, p) => n + p.uploads.length, 0)} file(s)`)
	for (const u of parts.flatMap((p) => p.uploads)) {
		const data = yield* fs.readFile(u.path)
		const r = yield* client.reports.putFile({ params: { id: created.id, name: u.name }, payload: data })
		yield* Console.error(`  ${r.name} (${(r.bytes / 1024).toFixed(0)} KB)`)
	}
	const done = yield* client.reports.finalize({ params: { id: created.id } })
	const section = path.join(path.resolve(o.runs.at(-1)!.dir), "hosted-section.md")
	yield* fs.writeFileString(section, hostedSection(manifest, done.url))
	yield* Console.error(`PR section: ${section} (witness publish --report it)`)
	yield* Console.log(done.url)
	return done.url
})
