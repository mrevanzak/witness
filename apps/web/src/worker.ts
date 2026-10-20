// Cloudflare Worker for hosted Witness reports. One Effect web handler per
// isolate, built from the bindings on the first request.
import { D1Client } from "@effect/sql-d1"
import { ReportApi } from "@witness/domain"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ReportsHandlers, UploadAuthLive } from "./api.ts"
import { notFoundPage, reportPage } from "./page.ts"
import { Bindings, ReportStore, ReportsRepo } from "./storage.ts"

export interface Env {
	readonly MEDIA: R2Bucket
	readonly DB: D1Database
	readonly UPLOAD_TOKEN: string
	/** Public origin for report links, e.g. https://reports.example.com (defaults to the request's). */
	readonly PUBLIC_URL?: string
}

const ID = /^[0-9A-Za-z]{22}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const PRIVATE = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }
const HTML = "text/html; charset=utf-8"
const notFound = HttpServerResponse.text(notFoundPage, { status: 404, contentType: HTML, headers: PRIVATE })

const PageRoutes = Layer.mergeAll(
	HttpRouter.add("GET", "/", HttpServerResponse.text("Witness reports are unlisted. Use the link you were given.", { headers: PRIVATE })),
	HttpRouter.add("GET", "/robots.txt", HttpServerResponse.text("User-agent: *\nDisallow: /\n")),
	HttpRouter.add(
		"GET",
		"/r/:id",
		Effect.gen(function* () {
			const { id } = yield* HttpRouter.params
			if (!id || !ID.test(id)) return notFound
			const row = yield* ReportsRepo.use((r) => r.get(id))
			if (Option.isNone(row) || row.value.status !== "ready") return notFound
			const manifest = yield* ReportStore.use((s) => s.manifest(id))
			if (Option.isNone(manifest)) return notFound
			return HttpServerResponse.text(reportPage(id, manifest.value), { contentType: HTML, headers: { ...PRIVATE, "cache-control": "private, max-age=60" } })
		}).pipe(Effect.catchTag("ReportStorageError", (e) => Effect.logError(e.message).pipe(Effect.as(HttpServerResponse.text("Storage error", { status: 500 })))))
	),
	HttpRouter.add(
		"GET",
		"/r/:id/:file",
		Effect.gen(function* () {
			const { id, file } = yield* HttpRouter.params
			if (!id || !file || !ID.test(id) || !FILE.test(file) || file === "manifest.json") return notFound
			const request = yield* HttpServerRequest.HttpServerRequest
			const found = yield* ReportStore.use((s) => s.file(id, file, request.headers.range))
			if (Option.isNone(found)) return notFound
			const f = found.value
			const headers: Record<string, string> = { ...PRIVATE, "accept-ranges": "bytes", etag: f.etag, "cache-control": "private, max-age=31536000, immutable" }
			const body = Stream.fromReadableStream({ evaluate: () => f.body, onError: (e) => e })
			return Option.match(f.range, {
				onNone: () => HttpServerResponse.stream(body, { contentType: f.contentType, headers: { ...headers, "content-length": String(f.size) } }),
				onSome: (r) =>
					HttpServerResponse.stream(body, {
						status: 206,
						contentType: f.contentType,
						headers: { ...headers, "content-length": String(r.length), "content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${f.size}` },
					}),
			})
		}).pipe(Effect.catchTag("ReportStorageError", (e) => Effect.logError(e.message).pipe(Effect.as(HttpServerResponse.text("Storage error", { status: 500 })))))
	)
)

const makeHandler = (env: Env) => {
	const bindings = Layer.succeed(Bindings, Bindings.of({ media: env.MEDIA, uploadToken: env.UPLOAD_TOKEN ?? "", publicUrl: Option.fromUndefinedOr(env.PUBLIC_URL) }))
	const storage = Layer.mergeAll(ReportStore.layer, ReportsRepo.layer.pipe(Layer.provide(D1Client.layer({ db: env.DB })))).pipe(Layer.provideMerge(bindings))
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
