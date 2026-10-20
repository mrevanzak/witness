// Run artifacts: plan.json, steps.jsonl, verdict.json, walkthrough.json and the
// manifest uploaded to the hosted viewer. Encoded shapes are the files on disk.
import { Schema } from "effect"
import { CriterionKind, CriterionStatus } from "./Ids.ts"

export class Criterion extends Schema.Class<Criterion>("@witness/Criterion")({
	id: Schema.String,
	kind: CriterionKind,
	description: Schema.String,
	how_to_check: Schema.String,
	evidence: Schema.String,
}) {}

export class Plan extends Schema.Class<Plan>("@witness/Plan")({
	summary: Schema.String,
	criteria: Schema.Array(Criterion),
}) {}

/** One line of steps.jsonl: a verifier tool call or walkthrough action. */
export class Step extends Schema.Class<Step>("@witness/Step")({
	/** Seconds since the first video frame (set once the recording stops). */
	t: Schema.optionalKey(Schema.Finite),
	/** Wall-clock ms on the computer's clock. */
	at: Schema.Finite,
	tool: Schema.String,
	/** Short human caption for the video. Never contains secrets. */
	label: Schema.optionalKey(Schema.String),
	criterion: Schema.optionalKey(Schema.String),
	/** Screen pixels (full resolution) of the action point. */
	x: Schema.optionalKey(Schema.Finite),
	y: Schema.optionalKey(Schema.Finite),
	to_x: Schema.optionalKey(Schema.Finite),
	to_y: Schema.optionalKey(Schema.Finite),
	status: Schema.optionalKey(Schema.Union([CriterionStatus, Schema.Finite, Schema.Null])),
	notes: Schema.optionalKey(Schema.String),
	forced: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	combo: Schema.optionalKey(Schema.String),
	chars: Schema.optionalKey(Schema.Finite),
	count: Schema.optionalKey(Schema.Finite),
	tail: Schema.optionalKey(Schema.Finite),
	file: Schema.optionalKey(Schema.String),
}) {}

export const StoppedBecause = Schema.Literals(["done", "max_steps", "wall_time", "budget", "refusal", "model_gave_up"])
export type StoppedBecause = typeof StoppedBecause.Type

export class VerdictCriterion extends Schema.Class<VerdictCriterion>("@witness/VerdictCriterion")({
	id: Schema.String,
	kind: CriterionKind,
	description: Schema.String,
	status: CriterionStatus,
	executor_status: CriterionStatus,
	/** [start, end] seconds into raw.mp4. */
	video_ts: Schema.OptionFromNullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
	screenshot: Schema.OptionFromNullOr(Schema.String),
	explanation: Schema.String,
	forced: Schema.optionalKey(Schema.String),
}) {}

export class ConsoleError extends Schema.Class<ConsoleError>("@witness/ConsoleError")({
	t: Schema.NullOr(Schema.Finite),
	type: Schema.String,
	text: Schema.String,
	url: Schema.String,
}) {}

export class NetworkError extends Schema.Class<NetworkError>("@witness/NetworkError")({
	t: Schema.NullOr(Schema.Finite),
	method: Schema.String,
	url: Schema.String,
	status: Schema.optionalKey(Schema.Finite),
	error: Schema.optionalKey(Schema.String),
}) {}

export class Usage extends Schema.Class<Usage>("@witness/Usage")({
	requests: Schema.Finite,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	cache_read_tokens: Schema.Finite,
	usd: Schema.Finite,
}) {}

export class Verdict extends Schema.Class<Verdict>("@witness/Verdict")({
	overall: CriterionStatus,
	summary: Schema.String,
	criteria: Schema.Array(VerdictCriterion),
	console_errors: Schema.Array(ConsoleError),
	network_errors: Schema.Array(NetworkError),
	notes: Schema.String,
	stopped_because: StoppedBecause,
	model: Schema.String,
	usage: Usage,
	duration_s: Schema.NullOr(Schema.Finite),
}) {}

/** verdict.json written when the run never reached the app (boot failure, bad config). */
export class BlockedVerdict extends Schema.Class<BlockedVerdict>("@witness/BlockedVerdict")({
	overall: Schema.Literal("blocked"),
	reason: Schema.String,
	notes: Schema.String,
	log_tail: Schema.optionalKey(Schema.String),
}) {}

export class Still extends Schema.Class<Still>("@witness/Still")({
	file: Schema.String,
	caption: Schema.String,
	at: Schema.Finite,
	t: Schema.optionalKey(Schema.Finite),
}) {}

export class WalkthroughReport extends Schema.Class<WalkthroughReport>("@witness/WalkthroughReport")({
	preview: Schema.String,
	intro: Schema.String,
	stills: Schema.Array(Still),
	notes: Schema.Array(Schema.String),
}) {}

export class RunInfo extends Schema.Class<RunInfo>("@witness/RunInfo")({
	id: Schema.String,
	repo: Schema.String,
	prefix: Schema.String,
	ref: Schema.String,
	sha: Schema.String,
	base: Schema.NullOr(Schema.String),
	task: Schema.String,
	startedAt: Schema.String,
}) {}

/**
 * What the hosted viewer stores per report: one or more run sections (a single
 * run, or before/after) plus the media paths uploaded next to it.
 */
export class ReportSection extends Schema.Class<ReportSection>("@witness/ReportSection")({
	label: Schema.optionalKey(Schema.String),
	sha: Schema.String,
	verdict: Verdict,
	stills: Schema.Array(Still),
	/** Uploaded media paths, relative to the report. */
	video: Schema.optionalKey(Schema.String),
	gif: Schema.optionalKey(Schema.String),
}) {}

export class ReportManifest extends Schema.Class<ReportManifest>("@witness/ReportManifest")({
	title: Schema.String,
	repo: Schema.optionalKey(Schema.String),
	pr: Schema.optionalKey(Schema.String),
	preview: Schema.String,
	intro: Schema.String,
	notes: Schema.Array(Schema.String),
	/** The verdict that counts (the "after" section for a before/after). */
	overall: CriterionStatus,
	sections: Schema.Array(ReportSection),
	createdAt: Schema.String,
}) {}
