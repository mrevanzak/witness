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
const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })))

export const ServiceSpec = Schema.Struct({
	image: NonEmpty,
	env: EnvMap.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	port: Schema.optionalKey(Port),
	/** A string runs through `sh -c`. */
	command: Schema.optionalKey(
		Schema.Union([NonEmpty, Schema.Array(NonEmpty)]).pipe(
			Schema.decodeTo(
				Schema.Array(Schema.String),
				SchemaTransformation.transform({ decode: (c) => (typeof c === "string" ? ["sh", "-c", c] : c), encode: (c) => c })
			)
		)
	),
})
export type ServiceSpec = typeof ServiceSpec.Type

export const Login = Schema.Struct({
	email: Schema.optionalKey(NonEmpty),
	username: Schema.optionalKey(NonEmpty),
	/** A secret: never logged, captioned or shown to the model. */
	password: Schema.optionalKey(NonEmpty),
})
export type Login = typeof Login.Type

const Seconds = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))

/** The file shape (snake_case keys, as written in YAML). */
const ConfigFile = Schema.Struct({
	setup: Schema.Union([NonEmpty, Schema.Array(NonEmpty)]).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	start: NonEmpty,
	url: HttpUrl,
	health: Schema.optionalKey(HttpUrl),
	services: Schema.Record(ServiceName, ServiceSpec).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	env: EnvMap.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	login: Schema.optionalKey(Login),
	timeouts: Schema.Struct({
		setup: Seconds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(900))),
		boot: Seconds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(180))),
	}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	files: Schema.Record(Schema.String, NonEmpty)
		.check(
			Schema.makeFilter((files) =>
				Object.keys(files)
					.filter((dest) => dest.startsWith("/") || dest.split("/").includes(".."))
					.map((dest) => ({ path: [dest], issue: `file destination ${dest} must be a path relative to the app` }))
			)
		)
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	secret_env: Schema.optionalKey(NonEmpty),
})

/** The decoded config (camelCase, defaults applied, optional parts as `Option`). */
export const WitnessConfig = Schema.Struct({
	setup: Schema.Array(Schema.String),
	start: Schema.String,
	url: Schema.String,
	/** Defaults to `url`. */
	health: Schema.String,
	services: Schema.Record(Schema.String, Schema.toType(ServiceSpec)),
	/** Env for setup/start (secret env is merged in by the orchestrator). */
	env: Schema.Record(Schema.String, Schema.String),
	login: Schema.Option(Schema.toType(Login)),
	timeouts: Schema.Struct({ setupSec: Schema.Number, bootSec: Schema.Number }),
	/** Host files staged into the app before setup. Only honoured from a verifier-side config. */
	files: Schema.Record(Schema.String, Schema.String),
	secretEnv: Schema.Option(Schema.String),
})
export type WitnessConfig = typeof WitnessConfig.Type

/** Values that must never appear in logs, steps, captions or reports. */
export const configSecrets = (config: WitnessConfig): ReadonlyArray<string> =>
	Option.match(config.login, {
		onNone: () => [],
		onSome: (l) => (l.password && l.password.length >= 3 ? [l.password] : []),
	})

const ConfigFromFile = ConfigFile.pipe(
	Schema.decodeTo(
		Schema.toType(WitnessConfig),
		SchemaTransformation.transform({
			decode: (f) => ({
				setup: typeof f.setup === "string" ? [f.setup] : f.setup,
				start: f.start,
				url: f.url,
				health: f.health ?? f.url,
				services: f.services,
				env: f.env,
				login: Option.fromUndefinedOr(f.login),
				timeouts: { setupSec: f.timeouts.setup, bootSec: f.timeouts.boot },
				files: f.files,
				secretEnv: Option.fromUndefinedOr(f.secret_env),
			}),
			encode: (c) => ({
				setup: c.setup,
				start: c.start,
				url: c.url,
				health: c.health,
				services: c.services,
				env: c.env,
				...Option.match(c.login, { onNone: () => ({}), onSome: (login) => ({ login }) }),
				timeouts: { setup: c.timeouts.setupSec, boot: c.timeouts.bootSec },
				files: c.files,
				...Option.match(c.secretEnv, { onNone: () => ({}), onSome: (secret_env) => ({ secret_env }) }),
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
		try: () => parse(text) as unknown,
		catch: (e) => new ConfigParseError({ message: `witness.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)}` }),
	})
	return yield* decodeConfig(raw).pipe(Effect.mapError((e) => new ConfigInvalidError({ message: e.message })))
})

/** Parses a KEY=VALUE env file (comments, blank lines and `export ` prefixes allowed). Pure. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const raw of text.split("\n")) {
		const line = raw.trim().replace(/^export\s+/, "")
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq <= 0) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
	}
	return out
}
