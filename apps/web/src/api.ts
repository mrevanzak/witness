// The upload API (bearer token) for `witness upload`.
import {
	ReportApi,
	ReportFileRejected,
	ReportId,
	ReportNotFound,
	UploadAuth,
	Uploader,
	UploadUnauthorized,
} from "@witness/domain"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Bindings, ReportStore, ReportsRepo } from "./storage.ts"

const MAX_FILE_BYTES = 95 * 1024 * 1024

/** 22 base62 chars from a CSPRNG (~131 bits): the unlisted-link secret. */
export const newReportId = (): ReportId => {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	let out = ""
	for (const b of bytes) {
		if (b >= 248) {
			continue // reject to keep the distribution uniform (248 = 62 * 4)
		}
		out += alphabet[b % 62]
		if (out.length === 22) {
			break
		}
	}
	return out.length === 22 ? Schema.decodeSync(ReportId)(out) : newReportId()
}

/** Constant-time string comparison for the upload token. */
const sameToken = (a: string, b: string) => {
	if (a.length !== b.length) {
		return false
	}
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}

export const UploadAuthLive = Layer.effect(
	UploadAuth,
	Effect.gen(function* () {
		const { uploadToken } = yield* Bindings
		return UploadAuth.of({
			bearer: Effect.fn(function* (httpEffect, { credential }) {
				if (!(uploadToken && sameToken(Redacted.value(credential), uploadToken))) {
					return yield* new UploadUnauthorized({ message: "missing or invalid upload token" })
				}
				return yield* Effect.provideService(httpEffect, Uploader, { ok: true })
			}),
		})
	})
)

const reportUrl = (base: Option.Option<string>, id: string) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		// originalUrl is absolute on Workers (the incoming Request's URL), so its scheme is the real one.
		const origin = Option.getOrElse(
			base,
			() => new URL(request.originalUrl, `https://${request.headers.host ?? "localhost"}`).origin
		)
		return `${origin.replace(/\/$/, "")}/r/${id}`
	})

export const ReportsHandlers = HttpApiBuilder.group(
	ReportApi,
	"reports",
	Effect.fn(function* (handlers) {
		const store = yield* ReportStore
		const repo = yield* ReportsRepo
		const { publicUrl } = yield* Bindings
		const exists = (id: string) =>
			repo.get(id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(new ReportNotFound({ id, message: `no report ${id}` })),
						onSome: Effect.succeed,
					})
				)
			)

		return handlers.handleAll({
			create: Effect.fn(function* ({ payload }) {
				const id = newReportId()
				yield* repo.insert(id, payload)
				yield* store.putManifest(id, payload)
				return { id, url: yield* reportUrl(publicUrl, id) }
			}),
			finalize: Effect.fn(function* ({ params }) {
				yield* exists(params.id)
				yield* repo.setReady(params.id)
				return { id: params.id, url: yield* reportUrl(publicUrl, params.id) }
			}),
			list: () => repo.list,
			putFile: Effect.fn(function* ({ params, payload }) {
				yield* exists(params.id)
				if (params.name === "manifest.json") {
					return yield* new ReportFileRejected({ message: "reserved name", name: params.name })
				}
				if (payload.length > MAX_FILE_BYTES) {
					return yield* new ReportFileRejected({
						message: `file is larger than ${MAX_FILE_BYTES} bytes`,
						name: params.name,
					})
				}
				const bytes = yield* store.putFile(params.id, params.name, payload)
				yield* repo.addBytes(params.id, bytes)
				return { bytes, name: params.name }
			}),
			remove: Effect.fn(function* ({ params }) {
				yield* exists(params.id)
				const deleted = yield* store.remove(params.id)
				yield* repo.remove(params.id)
				return { deleted, id: params.id }
			}),
		})
	})
)
