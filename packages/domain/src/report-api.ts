// The hosted-report API, shared by the Worker (apps/web) and the CLI's typed
// client. Reports are unlisted: the 22-char id is the secret that grants viewing.
import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"
import { ReportId } from "./ids.ts"
import { ReportManifest } from "./run.ts"

/** Uploaded file names are flat: `video-after.mp4`, `after-01-hub-js.png`. */
export const ReportFileName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)))

export class UploadUnauthorized extends Schema.TaggedError<UploadUnauthorized>()("UploadUnauthorized", { message: Schema.String }, { httpApiStatus: 401 }) {}

export class ReportNotFound extends Schema.TaggedError<ReportNotFound>()("ReportNotFound", { id: Schema.String, message: Schema.String }, { httpApiStatus: 404 }) {}

export class ReportFileRejected extends Schema.TaggedError<ReportFileRejected>()("ReportFileRejected", { name: Schema.String, message: Schema.String }, { httpApiStatus: 400 }) {}

export class ReportStorageError extends Schema.TaggedError<ReportStorageError>()("ReportStorageError", { message: Schema.String }, { httpApiStatus: 500 }) {}

/** Marker service: the upload token was valid. */
export class Uploader extends Context.Service<Uploader, { readonly ok: true }>()("witness/domain/ReportApi/Uploader") {}

export class UploadAuth extends HttpApiMiddleware.Service<UploadAuth, { provides: Uploader; requires: never }>()("witness/domain/ReportApi/UploadAuth", {
	requiredForClient: true,
	security: { bearer: HttpApiSecurity.bearer },
	error: UploadUnauthorized,
}) {}

export const ReportSummary = Schema.Struct({
	id: ReportId,
	title: Schema.String,
	repo: Schema.NullOr(Schema.String),
	pr: Schema.NullOr(Schema.String),
	overall: Schema.String,
	status: Schema.Literals(["uploading", "ready"]),
	bytes: Schema.Finite,
	created_at: Schema.String,
})
export type ReportSummary = typeof ReportSummary.Type

export class ReportsGroup extends HttpApiGroup.make("reports")
	.add(
		HttpApiEndpoint.post("create", "/api/reports", {
			payload: ReportManifest,
			success: Schema.Struct({ id: ReportId, url: Schema.String }),
			error: ReportStorageError,
		}),
		HttpApiEndpoint.put("putFile", "/api/reports/:id/files/:name", {
			params: { id: ReportId, name: ReportFileName },
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
			success: Schema.Struct({ name: Schema.String, bytes: Schema.Finite }),
			error: [ReportNotFound, ReportFileRejected, ReportStorageError],
		}),
		HttpApiEndpoint.post("finalize", "/api/reports/:id/finalize", {
			params: { id: ReportId },
			success: Schema.Struct({ id: ReportId, url: Schema.String }),
			error: [ReportNotFound, ReportStorageError],
		}),
		HttpApiEndpoint.get("list", "/api/reports", {
			success: Schema.Array(ReportSummary),
			error: ReportStorageError,
		}),
		HttpApiEndpoint.delete("remove", "/api/reports/:id", {
			params: { id: ReportId },
			success: Schema.Struct({ id: ReportId, deleted: Schema.Finite }),
			error: [ReportNotFound, ReportStorageError],
		})
	)
	.middleware(UploadAuth) {}

export class ReportApi extends HttpApi.make("witness-reports").add(ReportsGroup) {}
