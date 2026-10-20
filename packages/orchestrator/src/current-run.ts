// The run in progress: its directory, redacted event log and artifact writers.
// runs/<id>/ is orchestrator-owned; only runs/<id>/computer/ is mounted into the
// computer (the app under test must not be able to write verdict.json).

import { randomBytes } from "node:crypto"
import { redact, redactDeep } from "@witness/domain"
import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"

/** Writing a run artifact failed. */
export class RunWriteError extends Schema.TaggedError<RunWriteError>()("RunWriteError", {
	file: Schema.String,
	message: Schema.String,
}) {}

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
		log: (event: string, data?: Record<string, unknown>) => Effect.Effect<void>
		/** Encodes with `schema`, redacts, and writes `<dir>/<name>`. Returns the path. */
		writeJson: <A, I>(name: string, schema: Schema.Codec<A, I>, value: A) => Effect.Effect<string, RunWriteError>
		writeText: (name: string, text: string) => Effect.Effect<string, RunWriteError>
		writeBytes: (name: string, data: Uint8Array) => Effect.Effect<string, RunWriteError>
	}
>()("witness/orchestrator/CurrentRun") {
	/** A new run directory under `runsDir`. */
	static readonly layer = (runsDir: string, id?: string, publish: Publish = noPublish) =>
		Layer.effect(
			CurrentRun,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const runId = id ?? newRunId(new Date(yield* Clock.currentTimeMillis))
				const dir = path.resolve(runsDir, runId)
				const computerDir = path.join(dir, "computer")
				yield* fs
					.makeDirectory(computerDir, { recursive: true })
					.pipe(Effect.mapError((e) => new RunWriteError({ file: computerDir, message: e.message })))
				const secrets = yield* Ref.make<readonly string[]>([])
				const fail = (file: string) => (e: { readonly message: string }) =>
					new RunWriteError({ file, message: e.message })

				const writeText = Effect.fn("CurrentRun.writeText")(function* (name: string, text: string) {
					const file = path.join(dir, name)
					yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError(fail(file)))
					yield* fs.writeFileString(file, redact(text, yield* Ref.get(secrets))).pipe(Effect.mapError(fail(file)))
					return file
				})

				const writeBytes = Effect.fn("CurrentRun.writeBytes")(function* (name: string, data: Uint8Array) {
					const file = path.join(dir, name)
					yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.mapError(fail(file)))
					yield* fs.writeFile(file, data).pipe(Effect.mapError(fail(file)))
					return file
				})

				const writeJson = <A, I>(name: string, schema: Schema.Codec<A, I>, value: A) =>
					Schema.encodeEffect(schema)(value).pipe(
						Effect.mapError(fail(name)),
						Effect.flatMap((encoded) =>
							Effect.gen(function* () {
								return yield* writeText(
									name,
									`${JSON.stringify(redactDeep(encoded, yield* Ref.get(secrets)), null, 2)}\n`
								)
							})
						)
					)

				const log = Effect.fn("CurrentRun.log")(function* (event: string, data: Record<string, unknown> = {}) {
					const s = yield* Ref.get(secrets)
					const at = new Date(yield* Clock.currentTimeMillis).toISOString()
					const clean = redactDeep(data, s)
					yield* fs
						.writeFileString(path.join(dir, "run.log.jsonl"), `${JSON.stringify({ at, event, ...clean })}\n`, {
							flag: "a",
						})
						.pipe(Effect.ignore)
					yield* Effect.logInfo(event, clean).pipe(Effect.annotateLogs("run", runId))
					yield* publish({ at, data: clean, event, type: "log" })
				})

				return CurrentRun.of({
					addSecrets: (values) =>
						Ref.update(secrets, (s) => [...new Set([...s, ...values.filter((v) => v.length >= 3)])]),
					computerDir,
					dir,
					id: runId,
					log,
					publish,
					secrets: Ref.get(secrets),
					writeBytes,
					writeJson,
					writeText,
				})
			})
		)
}
