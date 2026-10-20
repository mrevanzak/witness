// The model seam. The verifier needs two things: send a Messages request, and send
// one that returns JSON decoded with an Effect Schema (whose JSON Schema is sent as
// the structured-output format). ClaudeModel wraps the official SDK; tests and the
// scripted e2e provide their own layer.
import Anthropic from "@anthropic-ai/sdk"
import { Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
export type ModelRequest = Omit<CreateParams, "model" | "betas" | "fallbacks">
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage

/** The API call failed (after the SDK's own retries). */
export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

/** The run's model spend reached its cap; no further requests are sent. */
export class ModelBudgetExceeded extends Schema.TaggedError<ModelBudgetExceeded>()("ModelBudgetExceeded", {
	limitUsd: Schema.Number,
	message: Schema.String,
	spentUsd: Schema.Number,
}) {}

/** A structured reply did not match its schema. */
export class ModelOutputInvalid extends Schema.TaggedError<ModelOutputInvalid>()("ModelOutputInvalid", {
	message: Schema.String,
}) {}

export type Usage = {
	readonly cacheRead: number
	readonly cacheWrite: number
	readonly input: number
	readonly output: number
	readonly requests: number
	readonly usd: number
}

/** $ per million tokens: [input, output, cache read]. Cache writes are 1.25x input. */
const PRICES: Record<string, readonly [number, number, number]> = {
	"claude-fable-5-1": [10, 50, 0.25],
	"claude-haiku-5-5": [0.1, 0.5, 0.01],
	"claude-opus-5-5": [4, 20, 0.2],
	"claude-sonnet-5-5": [2, 10, 0.2],
}

export const estimateUsd = (
	model: string,
	u: {
		input_tokens?: number | null
		output_tokens?: number | null
		cache_read_input_tokens?: number | null
		cache_creation_input_tokens?: number | null
	}
): number => {
	const [inp, out, read] = PRICES[model] ?? PRICES["claude-opus-5-5"]!
	return (
		((u.input_tokens ?? 0) * inp +
			(u.cache_creation_input_tokens ?? 0) * inp * 1.25 +
			(u.cache_read_input_tokens ?? 0) * read +
			(u.output_tokens ?? 0) * out) /
		1e6
	)
}

/** JSON Schema (draft 2020-12) for a structured-output format. */
export const outputFormat = <A, I>(schema: Schema.Codec<A, I>) => {
	const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
	const defs = Object.keys(doc.definitions).length ? { $defs: doc.definitions } : {}
	return { schema: { ...doc.schema, ...defs }, type: "json_schema" as const }
}

export const textOf = (m: ModelMessage): string =>
	m.content
		.flatMap((b) => (b.type === "text" ? [b.text] : []))
		.join("\n")
		.trim()

export class Model extends Context.Service<
	Model,
	{
		readonly id: string
		readonly usage: Effect.Effect<Usage>
		create: (request: ModelRequest) => Effect.Effect<ModelMessage, ModelError | ModelBudgetExceeded>
		/** A request whose reply is JSON matching `schema`. `None` when the model refused. */
		parse: <A, I>(
			request: ModelRequest,
			schema: Schema.Codec<A, I>
		) => Effect.Effect<Option.Option<A>, ModelError | ModelBudgetExceeded | ModelOutputInvalid>
	}
>()("witness/orchestrator/Model") {
	/** For modes that never call a model (walkthrough, boot-only): every call fails with ModelError. */
	static readonly unavailable = Layer.succeed(
		Model,
		Model.of({
			create: () => Effect.fail(new ModelError({ message: "no model in this mode", status: null })),
			id: "none",
			parse: () => Effect.fail(new ModelError({ message: "no model in this mode", status: null })),
			usage: Effect.succeed({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0, requests: 0, usd: 0 }),
		})
	)

	/** Claude through the official SDK. Config: WITNESS_MODEL, WITNESS_MAX_USD, WITNESS_FALLBACKS, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN. */
	static readonly claude = Layer.effect(
		Model,
		Effect.gen(function* () {
			const id = yield* Config.String("WITNESS_MODEL").pipe(Config.withDefault("claude-opus-5-5"))
			const maxUsd = yield* Config.Number("WITNESS_MAX_USD").pipe(Config.withDefault(5))
			const fallbacks = yield* Config.Boolean("WITNESS_FALLBACKS").pipe(Config.withDefault(true))
			const apiKey = yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY"))
			const authToken = yield* Config.option(Config.Redacted("ANTHROPIC_AUTH_TOKEN"))
			const client = new Anthropic({
				maxRetries: 4,
				...Option.match(apiKey, { onNone: () => ({}), onSome: (k) => ({ apiKey: Redacted.value(k) }) }),
				...Option.match(authToken, { onNone: () => ({}), onSome: (t) => ({ authToken: Redacted.value(t) }) }),
			})
			const usage = yield* Ref.make<Usage>({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0, requests: 0, usd: 0 })

			const params = (req: ModelRequest): CreateParams => {
				const betas: string[] = []
				const extra: Partial<CreateParams> = {}
				if (fallbacks) {
					betas.push("server-side-fallback-2026-07-01")
					extra.fallbacks = "default"
				}
				if (req.context_management) {
					betas.push("context-management-2025-06-27")
				}
				return { model: id, ...req, ...extra, betas }
			}

			const create = Effect.fn("Model.create")(function* (req: ModelRequest) {
				const spent = (yield* Ref.get(usage)).usd
				if (spent >= maxUsd) {
					return yield* new ModelBudgetExceeded({
						limitUsd: maxUsd,
						message: `model budget of $${maxUsd.toFixed(2)} reached ($${spent.toFixed(2)} spent)`,
						spentUsd: spent,
					})
				}
				const m = yield* Effect.tryPromise({
					catch: (e) =>
						new ModelError({
							message: e instanceof Error ? e.message : String(e),
							status: e instanceof Anthropic.APIError ? (e.status ?? null) : null,
						}),
					try: (signal) => client.beta.messages.create(params(req), { signal }),
				})
				const u = m.usage
				yield* Ref.update(usage, (s) => ({
					cacheRead: s.cacheRead + (u.cache_read_input_tokens ?? 0),
					cacheWrite: s.cacheWrite + (u.cache_creation_input_tokens ?? 0),
					input: s.input + (u.input_tokens ?? 0),
					output: s.output + (u.output_tokens ?? 0),
					requests: s.requests + 1,
					usd: s.usd + estimateUsd(m.model ?? id, u),
				}))
				return m
			})

			return Model.of({ create, id, parse: parseWith(create), usage: Ref.get(usage) })
		})
	)
}

/** `parse` on top of any `create`: sends the schema as the output format and decodes the reply. */
export const parseWith =
	(create: (request: ModelRequest) => Effect.Effect<ModelMessage, ModelError | ModelBudgetExceeded>) =>
	<A, I>(request: ModelRequest, schema: Schema.Codec<A, I>) =>
		Effect.gen(function* () {
			const m = yield* create({ ...request, output_config: { ...request.output_config, format: outputFormat(schema) } })
			if (m.stop_reason === "refusal") {
				return Option.none<A>()
			}
			const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(textOf(m)).pipe(
				Effect.mapError((e) => new ModelOutputInvalid({ message: e.message }))
			)
			return Option.some(decoded)
		})
