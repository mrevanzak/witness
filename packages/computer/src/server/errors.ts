import { Schema } from "effect"

/** xdotool / ImageMagick / xdpyinfo failed. */
export class DisplayError extends Schema.TaggedError<DisplayError>()("DisplayError", {
	message: Schema.String,
}) {}

/** Chromium is not reachable over CDP, or a page call failed. */
export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
	message: Schema.String,
}) {}

/** /record/start while recording, or /record/stop while idle. */
export class RecordingStateError extends Schema.TaggedError<RecordingStateError>()("RecordingStateError", {
	message: Schema.String,
}) {}

/** ffmpeg / ffprobe failed while finishing a recording. */
export class RecordingError extends Schema.TaggedError<RecordingError>()("RecordingError", {
	message: Schema.String,
}) {}

/** A shell command could not be started. */
export class ExecError extends Schema.TaggedError<ExecError>()("ExecError", {
	message: Schema.String,
}) {}

/** A path outside /artifacts was requested. */
export class ArtifactPathError extends Schema.TaggedError<ArtifactPathError>()("ArtifactPathError", {
	message: Schema.String,
	path: Schema.String,
}) {}

/** A requested artifact file does not exist. */
export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()("ArtifactNotFoundError", {
	message: Schema.String,
	path: Schema.String,
}) {}

/** Missing or wrong bearer token. */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()("UnauthorizedError", {
	message: Schema.String,
}) {}

/** The request body or query did not match the protocol schema. */
export class BadRequestError extends Schema.TaggedError<BadRequestError>()("BadRequestError", {
	message: Schema.String,
}) {}
