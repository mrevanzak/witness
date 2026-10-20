// The hosted-report API, shared by the Worker (apps/web) and the CLI's typed
// client. Reports are unlisted: the 22-char id is the secret that grants viewing.
import { Context, Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
} from "effect/http-api"
import { ReportId } from "./ids.ts"
import { ReportManifest } from "./run.ts"

/** Uploaded file names are flat: `video-after.mp4`, `after-01-hub-js.png`. */
export const ReportFileName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)))

/** Stored next to the media under each report; uploads may not use this name. */
export const MANIFEST_FILE = "manifest.json"

export class UploadUnauthorized extends Schema.TaggedError<UploadUnauthorized>()(
	"UploadUnauthorized",
	{ message: Schema.String },
	{ httpApiStatus: 401 }
) {}

export class ReportNotFound extends Schema.TaggedError<ReportNotFound>()(
	"ReportNotFound",
	{ id: Schema.String, message: Schema.String },
	{ httpApiStatus: 404 }
) {}

export class ReportFileRejected extends Schema.TaggedError<ReportFileRejected>()(
	"ReportFileRejected",
	{ message: Schema.String, name: Schema.String },
	{ httpApiStatus: 400 }
) {}

export class ReportStorageError extends Schema.TaggedError<ReportStorageError>()(
	"ReportStorageError",
	{ message: Schema.String },
	{ httpApiStatus: 500 }
) {}

/** Marker service: the upload token was valid. */
export class Uploader extends Context.Service<Uploader, { readonly ok: true }>()("witness/domain/ReportApi/Uploader") {}

export class UploadAuth extends HttpApiMiddleware.Service<UploadAuth, { provides: Uploader; requires: never }>()(
	"witness/domain/ReportApi/UploadAuth",
	{
		error: UploadUnauthorized,
		requiredForClient: true,
		security: { bearer: HttpApiSecurity.bearer },
	}
) {}

export class ReportsGroup extends HttpApiGroup.make("reports")
	.add(
		HttpApiEndpoint.post("create", "/api/reports", {
			error: ReportStorageError,
			payload: ReportManifest,
			success: Schema.Struct({ id: ReportId, url: Schema.String }),
		}),
		HttpApiEndpoint.put("putFile", "/api/reports/:id/files/:name", {
			error: [ReportNotFound, ReportFileRejected, ReportStorageError],
			params: { id: ReportId, name: ReportFileName },
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
			success: Schema.Struct({ bytes: Schema.Finite, name: Schema.String }),
		}),
		HttpApiEndpoint.post("finalize", "/api/reports/:id/finalize", {
			error: [ReportNotFound, ReportStorageError],
			params: { id: ReportId },
			success: Schema.Struct({ id: ReportId, url: Schema.String }),
		})
	)
	.middleware(UploadAuth) {}

export class ReportApi extends HttpApi.make("witness-reports").add(ReportsGroup) {}
