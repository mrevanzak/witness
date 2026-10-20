// R2 (manifest + media) and D1 (report rows) behind Effect services.
import { MANIFEST_FILE, type ReportId, ReportManifest, ReportStorageError } from "@witness/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

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

export class ReportStore extends Context.Service<
	ReportStore,
	{
		putFile: (id: ReportId, name: string, data: Uint8Array) => Effect.Effect<number, ReportStorageError>
		putManifest: (id: ReportId, manifest: ReportManifest) => Effect.Effect<void, ReportStorageError>
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
			const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ReportManifest))
			const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReportManifest))

			return ReportStore.of({
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
				manifest: (id) =>
					Effect.tryPromise({ catch: fail("get manifest"), try: () => media.get(key(id, MANIFEST_FILE)) }).pipe(
						Effect.flatMap((obj) =>
							obj
								? Effect.tryPromise({ catch: fail("read manifest"), try: () => obj.text() }).pipe(
										Effect.flatMap((t) => decodeManifest(t).pipe(Effect.mapError(fail("decode manifest")))),
										Effect.map(Option.some)
									)
								: Effect.succeed(Option.none())
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
				putManifest: (id, manifest) =>
					encodeManifest(manifest).pipe(
						Effect.mapError(fail("encode manifest")),
						Effect.flatMap((json) =>
							Effect.tryPromise({
								catch: fail("put manifest"),
								try: () =>
									media.put(key(id, MANIFEST_FILE), json, { httpMetadata: { contentType: "application/json" } }),
							})
						),
						Effect.asVoid
					),
			})
		})
	)
}

const ReportStatus = Schema.Literals(["uploading", "ready"])
type ReportStatus = typeof ReportStatus.Type

export class ReportsRepo extends Context.Service<
	ReportsRepo,
	{
		insert: (id: ReportId, manifest: ReportManifest) => Effect.Effect<void, ReportStorageError>
		setReady: (id: ReportId) => Effect.Effect<void, ReportStorageError>
		/** None when there is no such report. */
		status: (id: ReportId) => Effect.Effect<Option.Option<ReportStatus>, ReportStorageError>
	}
>()("witness/web/ReportsRepo") {
	static readonly layer = Layer.effect(
		ReportsRepo,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const db = <A, E>(what: string, e: Effect.Effect<A, E>) => e.pipe(Effect.mapError(fail(what)))
			const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ status: ReportStatus })))
			return ReportsRepo.of({
				insert: (id, m) =>
					db(
						"insert",
						sql`INSERT INTO reports (id, title, repo, pr, overall, status, created_at) VALUES (${id}, ${m.title}, ${m.repo ?? null}, ${m.pr ?? null}, ${m.overall}, 'uploading', ${m.createdAt})`
					).pipe(Effect.asVoid),
				setReady: (id) => db("update", sql`UPDATE reports SET status = 'ready' WHERE id = ${id}`).pipe(Effect.asVoid),
				status: (id) =>
					db("select", sql`SELECT status FROM reports WHERE id = ${id}`.pipe(Effect.flatMap(decodeRows))).pipe(
						Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), (r) => r.status))
					),
			})
		})
	)
}
