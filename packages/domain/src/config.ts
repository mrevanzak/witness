// `witness.yaml`: how to set up, start and reach the app under test.
import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { parse } from "yaml"

const NonEmpty = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/** Env values may be written as YAML numbers or booleans; they always reach the app as strings. */
const EnvValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).pipe(
	Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: (v) => String(v), encode: (s) => s }))
)

const EnvKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)))
const EnvMap = Schema.Record(EnvKey, EnvValue)

export const HttpUrl = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^https?:\/\/[^\s/]+/, { message: "must be an absolute http(s) URL" }))
)

const ServiceName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,30}$/)))
const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })))

export const ServiceSpec = Schema.Struct({
	/** A string runs through `sh -c`. */
	command: Schema.optionalKey(
		Schema.Union([NonEmpty, Schema.Array(NonEmpty)]).pipe(
			Schema.decodeTo(
				Schema.Array(Schema.String),
				SchemaTransformation.transform({
					decode: (c) => (typeof c === "string" ? ["sh", "-c", c] : c),
					encode: (c) => c,
				})
			)
		)
	),
	env: EnvMap.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	image: NonEmpty,
	port: Schema.optionalKey(Port),
})
export type ServiceSpec = typeof ServiceSpec.Type

export const Login = Schema.Struct({
	email: Schema.optionalKey(NonEmpty),
	/** A secret: never logged, captioned or shown to the model. */
	password: Schema.optionalKey(NonEmpty),
	username: Schema.optionalKey(NonEmpty),
})
export type Login = typeof Login.Type

/** Where published evidence goes: media in the PR itself, or a hosted report linked from the PR. */
export const EvidenceDestination = Schema.Literals(["pr", "hosted"])
export type EvidenceDestination = typeof EvidenceDestination.Type

/**
 * Which states of the app a run records: the base commit and then the change
 * (`before-after`, so reviewers see both), or the change alone (`after`).
 */
export const EvidenceStates = Schema.Literals(["before-after", "after"])
export type EvidenceStates = typeof EvidenceStates.Type

const Seconds = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))

/** The file shape (snake_case keys, as written in YAML). */
const ConfigFile = Schema.Struct({
	animation: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
	env: EnvMap.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	evidence: Schema.optionalKey(EvidenceDestination),
	files: Schema.Record(Schema.String, NonEmpty)
		.check(
			Schema.makeFilter((files) =>
				Object.keys(files)
					.filter((dest) => dest.startsWith("/") || dest.split("/").includes(".."))
					.map((dest) => ({ issue: `file destination ${dest} must be a path relative to the app`, path: [dest] }))
			)
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	health: Schema.optionalKey(HttpUrl),
	login: Schema.optionalKey(Login),
	secret_env: Schema.optionalKey(NonEmpty),
	services: Schema.Record(ServiceName, ServiceSpec).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	setup: Schema.Union([NonEmpty, Schema.Array(NonEmpty)]).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	start: NonEmpty,
	states: EvidenceStates.pipe(Schema.withDecodingDefaultKey(Effect.succeed("before-after" as const))),
	timeouts: Schema.Struct({
		boot: Seconds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(180))),
		setup: Seconds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(900))),
	}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	url: HttpUrl,
})

/** The decoded config (camelCase, defaults applied, optional parts as `Option`). */
export const WitnessConfig = Schema.Struct({
	/** Zoom, pan, cursor and click ripples in the polished video. */
	animation: Schema.Boolean,
	/** Env for setup/start (secret env is merged in by the orchestrator). */
	env: Schema.Record(Schema.String, Schema.String),
	evidence: Schema.Option(EvidenceDestination),
	/** Host files staged into the app before setup. Only honoured from a verifier-side config. */
	files: Schema.Record(Schema.String, Schema.String),
	/** Defaults to `url`. */
	health: Schema.String,
	login: Schema.Option(Schema.toType(Login)),
	secretEnv: Schema.Option(Schema.String),
	services: Schema.Record(Schema.String, Schema.toType(ServiceSpec)),
	setup: Schema.Array(Schema.String),
	start: Schema.String,
	states: EvidenceStates,
	timeouts: Schema.Struct({ bootSec: Schema.Number, setupSec: Schema.Number }),
	url: Schema.String,
})
export type WitnessConfig = typeof WitnessConfig.Type

/** Values that must never appear in logs, steps, captions or reports. */
export const configSecrets = (config: WitnessConfig): readonly string[] =>
	Option.match(config.login, {
		onNone: () => [],
		onSome: (l) => (l.password && l.password.length >= 3 ? [l.password] : []),
	})

const ConfigFromFile = ConfigFile.pipe(
	Schema.decodeTo(
		Schema.toType(WitnessConfig),
		SchemaTransformation.transform({
			decode: (f) => ({
				animation: f.animation,
				env: f.env,
				evidence: Option.fromUndefinedOr(f.evidence),
				files: f.files,
				health: f.health ?? f.url,
				login: Option.fromUndefinedOr(f.login),
				secretEnv: Option.fromUndefinedOr(f.secret_env),
				services: f.services,
				setup: typeof f.setup === "string" ? [f.setup] : f.setup,
				start: f.start,
				states: f.states,
				timeouts: { bootSec: f.timeouts.boot, setupSec: f.timeouts.setup },
				url: f.url,
			}),
			encode: (c) => ({
				animation: c.animation,
				env: c.env,
				health: c.health,
				services: c.services,
				setup: c.setup,
				start: c.start,
				states: c.states,
				url: c.url,
				...Option.match(c.login, { onNone: () => ({}), onSome: (login) => ({ login }) }),
				files: c.files,
				timeouts: { boot: c.timeouts.bootSec, setup: c.timeouts.setupSec },
				...Option.match(c.secretEnv, { onNone: () => ({}), onSome: (secret_env) => ({ secret_env }) }),
				...Option.match(c.evidence, { onNone: () => ({}), onSome: (evidence) => ({ evidence }) }),
			}),
		})
	)
)

const decodeConfig = Schema.decodeUnknownEffect(ConfigFromFile, { onExcessProperty: "error" })

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
	message: Schema.String,
}) {}

export class ConfigInvalidError extends Schema.TaggedError<ConfigInvalidError>()("ConfigInvalidError", {
	message: Schema.String,
}) {}

/** Parses `witness.yaml` text. */
export const parseWitnessConfig = Effect.fn("parseWitnessConfig")(function* (text: string) {
	const raw = yield* Effect.try({
		catch: (e) =>
			new ConfigParseError({
				message: `witness.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
			}),
		try: () => parse(text) as unknown,
	})
	return yield* decodeConfig(raw).pipe(Effect.mapError((e) => new ConfigInvalidError({ message: e.message })))
})

/** Parses a KEY=VALUE env file (comments, blank lines and `export ` prefixes allowed). Pure. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const raw of text.split("\n")) {
		const line = raw.trim().replace(/^export\s+/, "")
		if (!line || line.startsWith("#")) {
			continue
		}
		const eq = line.indexOf("=")
		if (eq <= 0) {
			continue
		}
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			out[key] = value
		}
	}
	return out
}
