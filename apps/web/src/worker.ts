// Cloudflare Worker for hosted Witness reports. One Effect web handler per
// isolate, built from the bindings on the first request.
import { D1Client } from "@effect/sql-d1"
import { MANIFEST_FILE, ReportApi, ReportFileName, ReportId, type ReportStorageError } from "@witness/domain"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { WorkerEnv } from "../alchemy.run.ts"
import { ReportsHandlers, UploadAuthLive } from "./api.ts"
import { notFoundPage, reportPage } from "./page.ts"
import { Bindings, ReportStore, ReportsRepo } from "./storage.ts"

/** Bindings declared in alchemy.run.ts: MEDIA (R2), DB (D1), UPLOAD_TOKEN, PUBLIC_URL. */
export type Env = WorkerEnv

const isReportId = Schema.is(ReportId)
const isFileName = Schema.is(ReportFileName)
const PRIVATE = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" }
const HTML = "text/html; charset=utf-8"
const notFound = HttpServerResponse.text(notFoundPage, { contentType: HTML, headers: PRIVATE, status: 404 })
const storageErrorAs500 = <A, R>(page: Effect.Effect<A, ReportStorageError, R>) =>
	page.pipe(
		Effect.catchTag("ReportStorageError", (e) =>
			Effect.logError(e.message).pipe(Effect.as(HttpServerResponse.text("Storage error", { status: 500 })))
		)
	)

const PageRoutes = Layer.mergeAll(
	HttpRouter.add(
		"GET",
		"/",
		HttpServerResponse.text("Witness reports are unlisted. Use the link you were given.", { headers: PRIVATE })
	),
	HttpRouter.add("GET", "/robots.txt", HttpServerResponse.text("User-agent: *\nDisallow: /\n")),
	HttpRouter.add(
		"GET",
		"/r/:id",
		Effect.gen(function* () {
			const { id } = yield* HttpRouter.params
			if (!isReportId(id)) {
				return notFound
			}
			const status = yield* ReportsRepo.use((r) => r.status(id))
			if (Option.isNone(status) || status.value !== "ready") {
				return notFound
			}
			const manifest = yield* ReportStore.use((s) => s.manifest(id))
			if (Option.isNone(manifest)) {
				return notFound
			}
			return HttpServerResponse.text(reportPage(id, manifest.value), {
				contentType: HTML,
				headers: { ...PRIVATE, "cache-control": "private, max-age=60" },
			})
		}).pipe(storageErrorAs500)
	),
	HttpRouter.add(
		"GET",
		"/r/:id/:file",
		Effect.gen(function* () {
			const { id, file } = yield* HttpRouter.params
			if (!(isReportId(id) && isFileName(file)) || file === MANIFEST_FILE) {
				return notFound
			}
			const request = yield* HttpServerRequest.HttpServerRequest
			const found = yield* ReportStore.use((s) => s.file(id, file, request.headers.range))
			if (Option.isNone(found)) {
				return notFound
			}
			const f = found.value
			const headers: Record<string, string> = {
				...PRIVATE,
				"accept-ranges": "bytes",
				"cache-control": "private, max-age=31536000, immutable",
				etag: f.etag,
			}
			const body = Stream.fromReadableStream({ evaluate: () => f.body, onError: (e) => e })
			return Option.match(f.range, {
				onNone: () =>
					HttpServerResponse.stream(body, {
						contentType: f.contentType,
						headers: { ...headers, "content-length": String(f.size) },
					}),
				onSome: (r) =>
					HttpServerResponse.stream(body, {
						contentType: f.contentType,
						headers: {
							...headers,
							"content-length": String(r.length),
							"content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${f.size}`,
						},
						status: 206,
					}),
			})
		}).pipe(storageErrorAs500)
	)
)

const makeHandler = (env: Env) => {
	const bindings = Layer.succeed(
		Bindings,
		Bindings.of({
			media: env.MEDIA,
			publicUrl: Option.fromUndefinedOr(env.PUBLIC_URL),
			uploadToken: env.UPLOAD_TOKEN ?? "",
		})
	)
	const storage = Layer.mergeAll(
		ReportStore.layer,
		ReportsRepo.layer.pipe(Layer.provide(D1Client.layer({ db: env.DB })))
	).pipe(Layer.provideMerge(bindings))
	const api = HttpApiBuilder.layer(ReportApi).pipe(Layer.provide(ReportsHandlers), Layer.provide(UploadAuthLive))
	const pages = PageRoutes.pipe(HttpRouter.provideRequest(storage))
	const routes = Layer.mergeAll(api, pages).pipe(Layer.provide(storage), Layer.provide(HttpServer.layerServices))
	return HttpRouter.toWebHandler(routes, { disableLogger: true }).handler
}

let handler: ReturnType<typeof makeHandler> | undefined

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		handler ??= makeHandler(env)
		return handler(request, Context.empty())
	},
} satisfies ExportedHandler<Env>
