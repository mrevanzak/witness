// `witness upload`: publish a run (or a before/after pair) as a hosted report on
// the Witness Worker (R2 + D1) and print its unlisted URL.
// It also writes hosted-section.md in the change's run dir: a short "## Manual
// verification" that links the page, ready for `witness publish --report`.
// Config: WITNESS_REPORTS_URL (the Worker's origin), WITNESS_UPLOAD_TOKEN.
import { pairSides, ReportApi, RUN_FILES, type RunPair, UploadAuth } from "@witness/domain"
import { readRenderedCut } from "@witness/renderer"
import { Config, Console, Effect, FileSystem, Option, Path, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"
import { buildReport, hostedSection, type ReportOptions } from "./report.ts"

/** Says when a run's video was rendered for the PR instead of the page, or too long ago to seek. */
const warnAboutRender = Effect.fnUntraced(function* (dir: string) {
	const cut = yield* readRenderedCut(dir)
	if (Option.isNone(cut)) {
		yield* Console.error(
			`warning: ${dir} has no render/rendered.json (not rendered, or by an older witness), so the page cannot seek to each criterion; render it with \`witness render --layout hosted\``
		)
	} else if (cut.value.layout === "pr") {
		yield* Console.error(
			`warning: ${dir} was rendered with the PR layout (criteria rail in the video, small on the page); re-render with \`witness render --layout hosted\``
		)
	}
})

export const upload = Effect.fn("upload")(function* (pair: RunPair, o: ReportOptions) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const baseUrl = yield* Config.String("WITNESS_REPORTS_URL")
	const token = yield* Config.Redacted("WITNESS_UPLOAD_TOKEN")

	for (const { run } of pairSides(pair)) {
		yield* warnAboutRender(run.dir)
	}
	const { manifest, media } = yield* buildReport(pair, o)

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
	yield* Console.error(`report ${created.id}: uploading ${media.size} file(s)`)
	for (const [name, file] of media) {
		const r = yield* client.reports.putFile({ params: { id: created.id, name }, payload: yield* fs.readFile(file) })
		yield* Console.error(`  ${r.name} (${(r.bytes / 1024).toFixed(0)} KB)`)
	}
	const done = yield* client.reports.finalize({ params: { id: created.id } })
	const section = path.join(pair.after.dir, RUN_FILES.hostedSection)
	yield* fs.writeFileString(section, hostedSection(manifest, done.url))
	yield* Console.error(`PR section: ${section} (witness publish --report it)`)
	yield* Console.log(done.url)
	return done.url
})
