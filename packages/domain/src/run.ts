// Run artifacts: plan.json, steps.jsonl, verdict.json, walkthrough.json and the
// manifest uploaded to the hosted viewer. Encoded shapes are the files on disk.
import { Effect, Schema } from "effect"
import { CriterionKind, CriterionStatus } from "./ids.ts"

export class Criterion extends Schema.Class<Criterion>("@witness/Criterion")({
	description: Schema.String,
	evidence: Schema.String,
	how_to_check: Schema.String,
	id: Schema.String,
	kind: CriterionKind,
}) {}

export class Plan extends Schema.Class<Plan>("@witness/Plan")({
	criteria: Schema.Array(Criterion),
	summary: Schema.String,
}) {}

/** One line of steps.jsonl: a verifier tool call or walkthrough action. */
export class Step extends Schema.Class<Step>("@witness/Step")({
	/** Wall-clock ms on the computer's clock. */
	at: Schema.Finite,
	chars: Schema.optionalKey(Schema.Finite),
	combo: Schema.optionalKey(Schema.String),
	count: Schema.optionalKey(Schema.Finite),
	criterion: Schema.optionalKey(Schema.String),
	file: Schema.optionalKey(Schema.String),
	forced: Schema.optionalKey(Schema.String),
	/** Short human caption for the video. Never contains secrets. */
	label: Schema.optionalKey(Schema.String),
	notes: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.Union([CriterionStatus, Schema.Finite, Schema.Null])),
	/** Seconds since the first video frame (set once the recording stops). */
	t: Schema.optionalKey(Schema.Finite),
	tail: Schema.optionalKey(Schema.Finite),
	to_x: Schema.optionalKey(Schema.Finite),
	to_y: Schema.optionalKey(Schema.Finite),
	tool: Schema.String,
	url: Schema.optionalKey(Schema.String),
	/** Screen pixels (full resolution) of the action point. */
	x: Schema.optionalKey(Schema.Finite),
	y: Schema.optionalKey(Schema.Finite),
}) {}

export const StoppedBecause = Schema.Literals(["done", "max_steps", "wall_time", "budget", "refusal", "model_gave_up"])
export type StoppedBecause = typeof StoppedBecause.Type

export class VerdictCriterion extends Schema.Class<VerdictCriterion>("@witness/VerdictCriterion")({
	description: Schema.String,
	executor_status: CriterionStatus,
	explanation: Schema.String,
	forced: Schema.optionalKey(Schema.String),
	id: Schema.String,
	kind: CriterionKind,
	screenshot: Schema.OptionFromNullOr(Schema.String),
	status: CriterionStatus,
	/** [start, end] seconds into raw.mp4. */
	video_ts: Schema.OptionFromNullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
}) {}

export class ConsoleError extends Schema.Class<ConsoleError>("@witness/ConsoleError")({
	t: Schema.NullOr(Schema.Finite),
	text: Schema.String,
	type: Schema.String,
	url: Schema.String,
}) {}

export class NetworkError extends Schema.Class<NetworkError>("@witness/NetworkError")({
	error: Schema.optionalKey(Schema.String),
	method: Schema.String,
	status: Schema.optionalKey(Schema.Finite),
	t: Schema.NullOr(Schema.Finite),
	url: Schema.String,
}) {}

export class Usage extends Schema.Class<Usage>("@witness/Usage")({
	cache_read_tokens: Schema.Finite,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	requests: Schema.Finite,
	usd: Schema.Finite,
}) {}

export class Verdict extends Schema.Class<Verdict>("@witness/Verdict")({
	console_errors: Schema.Array(ConsoleError),
	criteria: Schema.Array(VerdictCriterion),
	duration_s: Schema.NullOr(Schema.Finite),
	model: Schema.String,
	network_errors: Schema.Array(NetworkError),
	notes: Schema.String,
	overall: CriterionStatus,
	stopped_because: StoppedBecause,
	summary: Schema.String,
	usage: Usage,
}) {}

/** verdict.json written when the run never reached the app (boot failure, bad config). */
export class BlockedVerdict extends Schema.Class<BlockedVerdict>("@witness/BlockedVerdict")({
	log_tail: Schema.optionalKey(Schema.String),
	notes: Schema.String,
	overall: Schema.Literal("blocked"),
	reason: Schema.String,
}) {}

export class Still extends Schema.Class<Still>("@witness/Still")({
	at: Schema.Finite,
	caption: Schema.String,
	file: Schema.String,
	t: Schema.optionalKey(Schema.Finite),
}) {}

export class WalkthroughReport extends Schema.Class<WalkthroughReport>("@witness/WalkthroughReport")({
	intro: Schema.String,
	notes: Schema.Array(Schema.String),
	preview: Schema.String,
	stills: Schema.Array(Still),
}) {}

export class RunInfo extends Schema.Class<RunInfo>("@witness/RunInfo")({
	base: Schema.NullOr(Schema.String),
	id: Schema.String,
	prefix: Schema.String,
	ref: Schema.String,
	repo: Schema.String,
	sha: Schema.String,
	startedAt: Schema.String,
	task: Schema.String,
}) {}

/**
 * What the hosted viewer stores per report: one or more run sections (a single
 * run, or before/after) plus the media paths uploaded next to it.
 */
export class ReportSection extends Schema.Class<ReportSection>("@witness/ReportSection")({
	gif: Schema.optionalKey(Schema.String),
	label: Schema.optionalKey(Schema.String),
	/** Per criterion: [start, end] seconds in the polished video (where its check is shown). */
	seek: Schema.Record(Schema.String, Schema.Tuple([Schema.Finite, Schema.Finite])).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({}))
	),
	sha: Schema.String,
	stills: Schema.Array(Still),
	verdict: Verdict,
	/** Uploaded media paths, relative to the report. */
	video: Schema.optionalKey(Schema.String),
}) {}

export class ReportManifest extends Schema.Class<ReportManifest>("@witness/ReportManifest")({
	createdAt: Schema.String,
	intro: Schema.String,
	notes: Schema.Array(Schema.String),
	/** The verdict that counts (the "after" section for a before/after). */
	overall: CriterionStatus,
	pr: Schema.optionalKey(Schema.String),
	preview: Schema.String,
	repo: Schema.optionalKey(Schema.String),
	sections: Schema.Array(ReportSection),
	title: Schema.String,
}) {}
