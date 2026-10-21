// Reports in R2 behind an Effect service. A report being uploaded keeps its
// manifest at pending/<id>.json; finalizing moves it to reports/<id>/manifest.json,
// and only then does the page show it.
import { MANIFEST_FILE, type ReportId, ReportManifest, ReportStorageError } from "@witness/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"

export class Bindings extends Context.Service<
	Bindings,
	{ readonly media: R2Bucket; readonly uploadToken: string; readonly publicUrl: Option.Option<string> }
>()("witness/web/Bindings") {}

const fail = (what: string) => (e: unknown) =>
	new ReportStorageError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

export type StoredFile = {
	readonly body: ReadableStream
	readonly contentType: string
	readonly etag: string
	readonly range: Option.Option<{ readonly offset: number; readonly length: number }>
	readonly size: number
}

const CONTENT_TYPES: Record<string, string> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	mp4: "video/mp4",
	png: "image/png",
	vtt: "text/vtt; charset=utf-8",
	webm: "video/webm",
}
export const contentTypeOf = (name: string) =>
	CONTENT_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` against a known size. Pure. */
export const parseRange = (
	header: string | undefined,
	size: number
): Option.Option<{ offset: number; length: number }> => {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/)
	if (!(m && (m[1] || m[2]))) {
		return Option.none()
	}
	const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
	const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
	if (start > end || start >= size) {
		return Option.none()
	}
	return Option.some({ length: end - start + 1, offset: start })
}

export type ReportStatus = "uploading" | "ready"

export class ReportStore extends Context.Service<
	ReportStore,
	{
		/** Starts an upload: the report exists, `uploading`, until `finalize`. */
		create: (id: ReportId, manifest: ReportManifest) => Effect.Effect<void, ReportStorageError>
		finalize: (id: ReportId) => Effect.Effect<void, ReportStorageError>
		/** None when there is no such report. */
		status: (id: ReportId) => Effect.Effect<Option.Option<ReportStatus>, ReportStorageError>
		putFile: (id: ReportId, name: string, data: Uint8Array) => Effect.Effect<number, ReportStorageError>
		/** The manifest of a finalized report. */
		manifest: (id: ReportId) => Effect.Effect<Option.Option<ReportManifest>, ReportStorageError>
		file: (
			id: ReportId,
			name: string,
			rangeHeader: string | undefined
		) => Effect.Effect<Option.Option<StoredFile>, ReportStorageError>
	}
>()("witness/web/ReportStore") {
	static readonly layer = Layer.effect(
		ReportStore,
		Effect.gen(function* () {
			const { media } = yield* Bindings
			const key = (id: ReportId, name: string) => `reports/${id}/${name}`
			const pendingKey = (id: ReportId) => `pending/${id}.json`
			const asJson = { httpMetadata: { contentType: "application/json" } }
			const getText = (k: string, what: string) =>
				Effect.tryPromise({
					catch: fail(`get ${what}`),
					try: async () => Option.fromUndefinedOr(await (await media.get(k))?.text()),
				})
			const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ReportManifest))
			const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReportManifest))

			return ReportStore.of({
				create: (id, manifest) =>
					encodeManifest(manifest).pipe(
						Effect.mapError(fail("encode manifest")),
						Effect.flatMap((json) =>
							Effect.tryPromise({
								catch: fail("put pending manifest"),
								try: () => media.put(pendingKey(id), json, asJson),
							})
						),
						Effect.asVoid
					),
				file: (id, name, rangeHeader) =>
					Effect.gen(function* () {
						const head = yield* Effect.tryPromise({ catch: fail("head"), try: () => media.head(key(id, name)) })
						if (!head) {
							return Option.none()
						}
						const range = parseRange(rangeHeader, head.size)
						const obj = yield* Effect.tryPromise({
							catch: fail("get"),
							try: () =>
								media.get(key(id, name), Option.match(range, { onNone: () => ({}), onSome: (r) => ({ range: r }) })),
						})
						if (!(obj && "body" in obj)) {
							return Option.none()
						}
						return Option.some({
							body: obj.body,
							contentType: head.httpMetadata?.contentType ?? contentTypeOf(name),
							etag: head.httpEtag,
							range,
							size: head.size,
						})
					}),
				finalize: (id) =>
					getText(pendingKey(id), "pending manifest").pipe(
						Effect.flatMap(
							Option.match({
								// Already finalized.
								onNone: () => Effect.void,
								onSome: (json) =>
									Effect.tryPromise({
										catch: fail("finalize"),
										try: async () => {
											await media.put(key(id, MANIFEST_FILE), json, asJson)
											await media.delete(pendingKey(id))
										},
									}),
							})
						)
					),
				manifest: (id) =>
					getText(key(id, MANIFEST_FILE), "manifest").pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.succeed(Option.none()),
								onSome: (t) =>
									decodeManifest(t).pipe(Effect.mapError(fail("decode manifest")), Effect.map(Option.some)),
							})
						)
					),
				putFile: (id, name, data) =>
					Effect.tryPromise({
						catch: fail("put"),
						try: () =>
							media.put(key(id, name), data, {
								httpMetadata: {
									cacheControl: "private, max-age=31536000, immutable",
									contentType: contentTypeOf(name),
								},
							}),
					}).pipe(Effect.as(data.length)),
				status: (id) =>
					Effect.tryPromise({
						catch: fail("status"),
						try: async (): Promise<Option.Option<ReportStatus>> => {
							if (await media.head(key(id, MANIFEST_FILE))) {
								return Option.some("ready")
							}
							return (await media.head(pendingKey(id))) ? Option.some("uploading") : Option.none()
						},
					}),
			})
		})
	)
}
