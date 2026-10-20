// The run in progress: its directory, redacted event log and artifact writers.
// runs/<id>/ is orchestrator-owned; only runs/<id>/computer/ is mounted into the
// computer (the app under test must not be able to write verdict.json).
// Files are written whole (temp file, then rename), since the CLI and the live
// view read them while the run goes.

import { randomBytes } from "node:crypto"
import { type CriterionKind, type CriterionStatus, isRedactable, redact, redactDeep } from "@witness/domain"
import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"

/** Writing a run artifact failed. */
export class RunWriteError extends Schema.TaggedError<RunWriteError>()("RunWriteError", {
	file: Schema.String,
	message: Schema.String,
}) {}

type Declared = { readonly description: string; readonly id: string; readonly kind: CriterionKind }

/** Log events the live view reads, with the data it reads from them. Other events carry any data. */
export type LiveEventData = {
	readonly "boot.blocked": { readonly message: string; readonly stage: string }
	readonly "boot.setup": { readonly cmd: string; readonly ms: number }
	readonly "computer.created": { readonly id: string; readonly liveView: string | undefined; readonly network: string }
	readonly "criterion.declared": Declared
	readonly "plan.done": { readonly criteria: readonly Declared[] }
	readonly "run.blocked": { readonly message: string; readonly reason: string }
	readonly "run.start": {
		readonly base: string | null
		readonly mode: string
		readonly prefix: string
		readonly repo: string
		readonly runDir: string
		readonly sha: string
	}
	readonly "state.start": { readonly sha: string; readonly state: "before" | "after" }
	readonly verdict: { readonly criteria: readonly string[]; readonly overall: CriterionStatus; readonly usd: number }
}
type LogData<E extends string> = E extends keyof LiveEventData ? LiveEventData[E] : Record<string, unknown>

/** What a live viewer receives: run log events and steps, redacted, in order. */
export type LiveEvent =
	| { readonly type: "log"; readonly at: string; readonly event: string; readonly data: Record<string, unknown> }
	| { readonly type: "step"; readonly step: Record<string, unknown> }

export type Publish = (event: LiveEvent) => Effect.Effect<void>
const noPublish: Publish = () => Effect.void

export const newRunId = (now: Date): string => {
	const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
	return `${ts}-${randomBytes(3).toString("hex")}`
}

export class CurrentRun extends Context.Service<
	CurrentRun,
	{
		readonly id: string
		/** Orchestrator-owned outputs. */
		readonly dir: string
		/** Bind-mounted at /artifacts in the computer (written by the untrusted side). */
		readonly computerDir: string
		readonly secrets: Effect.Effect<readonly string[]>
		/** Sends an already-redacted event to live viewers (no-op without --live). */
		publish: Publish
		addSecrets: (values: readonly string[]) => Effect.Effect<void>
		/** Appends a redacted event to run.log.jsonl and logs it. */
		log: <E extends string>(event: E, data?: LogData<E>) => Effect.Effect<void>
		/** Encodes with `schema`, redacts, and writes `<dir>/<name>`. Returns the path. */
		writeJson: <A, I>(name: string, schema: Schema.Codec<A, I>, value: A) => Effect.Effect<string, RunWriteError>
		writeText: (name: string, text: string) => Effect.Effect<string, RunWriteError>
		/** Appends redacted text to `<dir>/<name>`. */
		appendText: (name: string, text: string) => Effect.Effect<void, RunWriteError>
		writeBytes: (name: string, data: Uint8Array) => Effect.Effect<string, RunWriteError>
	}
>()("witness/orchestrator/CurrentRun") {
	/** A new run directory under `runsDir`, named after the run unless `folder` is given. */
	static readonly layer = (runsDir: string, id?: string, publish: Publish = noPublish, folder?: string) =>
		Layer.effect(
			CurrentRun,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const runId = id ?? newRunId(new Date(yield* Clock.currentTimeMillis))
				const dir = path.resolve(runsDir, folder ?? runId)
				const computerDir = path.join(dir, "computer")
				yield* fs
					.makeDirectory(computerDir, { recursive: true })
					.pipe(Effect.mapError((e) => new RunWriteError({ file: computerDir, message: e.message })))
				const secrets = yield* Ref.make<readonly string[]>([])
				const fail = (file: string) => (e: { readonly message: string }) =>
					new RunWriteError({ file, message: e.message })

				/** Writes `data` to a temp file next to `name`, then renames it into place. */
				const writeWhole = Effect.fnUntraced(function* (name: string, data: Uint8Array | string) {
					const file = path.join(dir, name)
					const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`
					yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError(fail(file)))
					yield* (typeof data === "string" ? fs.writeFileString(tmp, data) : fs.writeFile(tmp, data)).pipe(
						Effect.mapError(fail(file))
					)
					yield* fs.rename(tmp, file).pipe(Effect.mapError(fail(file)))
					return file
				})

				const writeText = Effect.fn("CurrentRun.writeText")(function* (name: string, text: string) {
					return yield* writeWhole(name, redact(text, yield* Ref.get(secrets)))
				})

				const appendText = Effect.fn("CurrentRun.appendText")(function* (name: string, text: string) {
					const file = path.join(dir, name)
					yield* fs
						.writeFileString(file, redact(text, yield* Ref.get(secrets)), { flag: "a" })
						.pipe(Effect.mapError(fail(file)))
				})

				const writeJson = <A, I>(name: string, schema: Schema.Codec<A, I>, value: A) =>
					Effect.gen(function* () {
						const encoded = yield* Schema.encodeEffect(schema)(value).pipe(Effect.mapError(fail(name)))
						return yield* writeText(name, `${JSON.stringify(redactDeep(encoded, yield* Ref.get(secrets)), null, 2)}\n`)
					})

				const log = Effect.fn("CurrentRun.log")(function* (event: string, data: Record<string, unknown> = {}) {
					const at = new Date(yield* Clock.currentTimeMillis).toISOString()
					const clean = redactDeep(data, yield* Ref.get(secrets))
					yield* appendText("run.log.jsonl", `${JSON.stringify({ at, event, ...clean })}\n`).pipe(Effect.ignore)
					yield* Effect.logInfo(event, clean).pipe(Effect.annotateLogs("run", runId))
					yield* publish({ at, data: clean, event, type: "log" })
				})

				return CurrentRun.of({
					addSecrets: (values) => Ref.update(secrets, (s) => [...new Set([...s, ...values.filter(isRedactable)])]),
					appendText,
					computerDir,
					dir,
					id: runId,
					log: log as CurrentRun["Service"]["log"],
					publish,
					secrets: Ref.get(secrets),
					writeBytes: (name, data) => writeWhole(name, data),
					writeJson,
					writeText,
				})
			})
		)
}
