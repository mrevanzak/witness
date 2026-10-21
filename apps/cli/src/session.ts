// `witness run --session`: a live run that the calling Claude Code session drives
// itself. The run boots the app, starts recording, then takes commands on a local
// endpoint; `witness act <action>` sends one recorded action at a time (click,
// type, begin/end a criterion, take a still) and prints a screenshot path to look
// at. `witness act finish` ends a side and the run writes its verdict as usual.
//
// `run --session` detaches the run into a background process and returns once
// the session is ready (or the app failed to boot), so the caller needs no
// background shell. The process serves one endpoint for its whole life and says
// which side is up through `GET /status`.
//
// With `states: before-after` the first side is the base commit (in
// `<runDir>/before/`). Finishing it boots the change with the same criteria
// declared, and `act finish` returns once that side is ready.

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { openSync } from "node:fs"
import { EXIT_ERROR, exitCodeOf, RUN_FILES, requireRunFile, VerdictFile } from "@witness/domain"
import {
	ActionFailed,
	newRunId,
	Recorder,
	type RecorderApi,
	SESSION_SHOT_WIDTH,
	type SessionProgram,
} from "@witness/orchestrator"
import {
	Clock,
	Console,
	Deferred,
	Effect,
	FileSystem,
	Option,
	Path,
	Ref,
	Schema,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { serveLoopback } from "./live.ts"
import { ACTION_SPECS, ACTIONS, type ActionName, bad } from "./session-actions.ts"
import { printVerdict } from "./verdict-text.ts"

/** Written to <runDir>/driver.json while the session process runs; removed when it ends. */
const DriverInfo = Schema.Struct({ token: Schema.String, url: Schema.String })
const DriverInfoJson = Schema.fromJsonString(DriverInfo)

/** Which side of the run takes commands. `seq` grows with every change. */
const SessionStatus = Schema.Union([
	Schema.TaggedStruct("Booting", { seq: Schema.Int }),
	Schema.TaggedStruct("Ready", {
		carried: Schema.Array(Schema.String),
		/** That side's run folder. */
		runDir: Schema.String,
		seq: Schema.Int,
		sha: Schema.String,
		side: Schema.Literals(["before", "after", "single"]),
	}),
	Schema.TaggedStruct("Finished", { seq: Schema.Int }),
])
type SessionStatus = typeof SessionStatus.Type
type Ready = Extract<SessionStatus, { _tag: "Ready" }>

/** No session to talk to, or a command was malformed. */
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", { message: Schema.String }) {}

const ActRequest = Schema.Struct({
	action: Schema.Literals(ACTIONS),
	args: Schema.Array(Schema.String),
	label: Schema.optionalKey(Schema.String),
})
const ActResponse = Schema.Struct({
	error: Schema.optionalKey(Schema.String),
	ok: Schema.Boolean,
	shot: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
})
type ActResponse = typeof ActResponse.Type

/** The side taking commands right now. */
type Side = {
	readonly recorder: RecorderApi
	readonly done: Deferred.Deferred<void>
	readonly lastAt: Ref.Ref<number>
}

/**
 * The session process's command endpoint, for its whole life (both sides of a
 * before/after). Returns the program each side runs, and `finished` for when the
 * run is over.
 */
export const sessionHost = Effect.fnUntraced(function* (runDir: string, idleMs: number) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const status = yield* SubscriptionRef.make<SessionStatus>({ _tag: "Booting", seq: 0 })
	const current = yield* Ref.make(Option.none<Side>())
	const lock = yield* Semaphore.make(1)
	const shotNo = yield* Ref.make(0)
	const setStatus = (next: (seq: number) => SessionStatus) => SubscriptionRef.update(status, (s) => next(s.seq + 1))

	/** Saves a screen the driver looks at, and returns its path. */
	const look = (data: Uint8Array) =>
		Effect.gen(function* () {
			const n = yield* Ref.updateAndGet(shotNo, (x) => x + 1)
			const dir = path.join(runDir, "session")
			yield* fs.makeDirectory(dir, { recursive: true })
			const file = path.join(dir, `${String(n).padStart(3, "0")}.jpg`)
			yield* fs.writeFile(file, data)
			return file
		})

	const act = (req: typeof ActRequest.Type) =>
		Effect.gen(function* () {
			const side = yield* Ref.get(current)
			if (Option.isNone(side)) {
				return yield* bad("no side is ready yet (the app is booting); try again in a moment")
			}
			const { done, lastAt, recorder } = side.value
			yield* Ref.set(lastAt, yield* Clock.currentTimeMillis)
			if (req.action === "finish") {
				yield* Deferred.succeed(done, undefined)
				return { ok: true, text: "finishing" } satisfies ActResponse
			}
			const calls = yield* ACTION_SPECS[req.action].parse(req.args, Option.fromUndefinedOr(req.label))
			const texts: string[] = []
			let shot: string | undefined
			for (const call of calls) {
				const r = yield* recorder.perform(call)
				texts.push(r.text)
				if (Option.isSome(r.screen)) {
					shot = yield* look(r.screen.value.data).pipe(Effect.mapError((e) => new ActionFailed({ message: e.message })))
				}
			}
			yield* Ref.set(lastAt, yield* Clock.currentTimeMillis)
			return { ok: true, text: texts.join("\n"), ...(shot ? { shot } : {}) } satisfies ActResponse
		}).pipe(
			Effect.catch((e) => Effect.succeed({ error: e.message, ok: false } satisfies ActResponse)),
			Semaphore.withPermit(lock)
		)

	const token = randomBytes(24).toString("hex")
	const authorized = HttpServerRequest.HttpServerRequest.pipe(
		Effect.map((r) => r.headers.authorization === `Bearer ${token}`)
	)
	const unauthorized = HttpServerResponse.json({ error: "unauthorized", ok: false }, { status: 401 })
	const origin = yield* serveLoopback(
		HttpRouter.addAll([
			HttpRouter.route(
				"POST",
				"/act",
				Effect.gen(function* () {
					if (!(yield* authorized)) {
						return yield* unauthorized
					}
					const body = yield* HttpServerRequest.schemaBodyJson(ActRequest).pipe(Effect.option)
					return yield* Option.match(body, {
						onNone: () => HttpServerResponse.json({ error: "bad request", ok: false }, { status: 400 }),
						onSome: (b) => act(b).pipe(Effect.flatMap((r) => HttpServerResponse.json(r))),
					})
				}).pipe(Effect.orDie)
			),
			// Long poll: answers once the status is newer than `since`, or after 20 s.
			HttpRouter.route(
				"GET",
				"/status",
				Effect.gen(function* () {
					if (!(yield* authorized)) {
						return yield* unauthorized
					}
					const query = yield* HttpServerRequest.schemaSearchParams(
						Schema.Struct({ since: Schema.optionalKey(Schema.NumberFromString) })
					)
					const since = query.since ?? -1
					const next = yield* SubscriptionRef.changes(status).pipe(
						Stream.filter((s) => s.seq > since),
						Stream.runHead,
						Effect.timeout("20 seconds"),
						Effect.catchTag("TimeoutError", () => Effect.succeed(Option.none<SessionStatus>())),
						Effect.flatMap(Option.match({ onNone: () => SubscriptionRef.get(status), onSome: Effect.succeed }))
					)
					return yield* HttpServerResponse.json(Schema.encodeSync(SessionStatus)(next))
				}).pipe(Effect.orDie)
			),
		])
	)
	const driverFile = path.join(runDir, RUN_FILES.driver)
	yield* Effect.acquireRelease(
		fs.writeFileString(driverFile, Schema.encodeSync(DriverInfoJson)({ token, url: origin })),
		() => fs.remove(driverFile).pipe(Effect.ignore)
	)

	const program: SessionProgram = (side) =>
		Effect.gen(function* () {
			const recorder = yield* Recorder
			const done = yield* Deferred.make<void>()
			const lastAt = yield* Ref.make(yield* Clock.currentTimeMillis)
			yield* Ref.set(current, Option.some({ done, lastAt, recorder }))
			yield* setStatus((seq) => ({
				_tag: "Ready",
				carried: side.carried.map((c) => c.id),
				runDir: recorder.runDir,
				seq,
				sha: side.sha,
				side: Option.getOrElse(side.state, () => "single" as const),
			}))
			yield* Console.log(`session ready: ${recorder.runDir}`)
			const idle = Effect.gen(function* () {
				for (;;) {
					yield* Effect.sleep("5 seconds")
					if ((yield* Clock.currentTimeMillis) - (yield* Ref.get(lastAt)) > idleMs) {
						return yield* bad(`no command for ${Math.round(idleMs / 1000)} s; the session closed itself`)
					}
				}
			})
			yield* Effect.raceFirst(Deferred.await(done), idle)
		}).pipe(
			Effect.ensuring(
				Ref.set(current, Option.none()).pipe(Effect.andThen(setStatus((seq) => ({ _tag: "Booting", seq }))))
			)
		)

	return {
		/** Tells waiting drivers the run is over, and gives them a moment to hear it. */
		finished: setStatus((seq) => ({ _tag: "Finished", seq })).pipe(Effect.andThen(Effect.sleep("1 second"))),
		program,
	}
})

/** The open session's run dir: `run`, or the only one under `runsDir` with a driver.json. */
const findSession = Effect.fnUntraced(function* (run: Option.Option<string>, runsDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (Option.isSome(run)) {
		return path.resolve(run.value)
	}
	const root = path.resolve(runsDir)
	const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]))
	const open = yield* Effect.filter(names, (name) =>
		fs.exists(path.join(root, name, RUN_FILES.driver)).pipe(Effect.orElseSucceed(() => false))
	)
	if (open.length === 1) {
		return path.join(root, open[0])
	}
	// Each trigger has its own computer; guessing between several would drive someone else's.
	if (open.length > 1) {
		return yield* new SessionError({
			message: `${open.length} sessions are open under ${root} (${open.join(", ")}); pass --run <runDir> for yours`,
		})
	}
	return yield* new SessionError({ message: `no open session under ${root}; start one with \`witness run --session\`` })
})

/** A client for the session process whose driver.json is in `runDir`. */
const connect = Effect.fnUntraced(function* (runDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const info = yield* fs.readFileString(path.join(runDir, RUN_FILES.driver)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(DriverInfoJson)),
		Effect.mapError(() => new SessionError({ message: `no open session in ${runDir}` }))
	)
	const client = (yield* HttpClient.HttpClient).pipe(
		HttpClient.mapRequest((r) =>
			r.pipe(HttpClientRequest.prependUrl(info.url), HttpClientRequest.bearerToken(info.token))
		)
	)
	const gone = (e: { readonly message: string }) =>
		new SessionError({ message: `the session in ${runDir} did not answer: ${e.message}` })
	return {
		act: (body: typeof ActRequest.Type) =>
			client
				.execute(HttpClientRequest.post("/act").pipe(HttpClientRequest.bodyJsonUnsafe(body)))
				.pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(ActResponse)),
					Effect.timeout("150 seconds"),
					Effect.mapError(gone)
				),
		/** The status once it is newer than `since`; `Finished` once the process is gone. */
		status: (since: number) =>
			client.get(`/status?since=${since}`).pipe(
				Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionStatus)),
				Effect.timeout("30 seconds"),
				Effect.catch(() =>
					fs.exists(path.join(runDir, RUN_FILES.driver)).pipe(
						Effect.orElseSucceed(() => false),
						Effect.flatMap((open) =>
							open
								? Effect.fail(new SessionError({ message: `the session in ${runDir} stopped answering` }))
								: Effect.succeed<SessionStatus>({ _tag: "Finished", seq: since + 1 })
						)
					)
				)
			),
	}
})

/** What `run --session` and `act finish` print once a side can take commands. */
const readyText = (s: Ready) =>
	[
		"",
		...(s.side === "before"
			? [
					`BEFORE: the base commit ${s.sha} is up, without the change. Declare your criteria and check them here first.`,
					"`act finish` records this side, then boots the change with the same criteria declared. Reuse still names there so they pair up in the report.",
				]
			: []),
		...(s.side === "after"
			? [
					`AFTER: the change ${s.sha} is up${s.carried.length ? `, with ${s.carried.join(", ")} declared from the before run` : ""}. Check each criterion again, reusing the before run's still names.`,
				]
			: []),
		"SESSION READY. Drive it with `witness act <action> [args] [--label <caption>]`:",
		...Object.values(ACTION_SPECS).map((a) => `  ${a.usage}`),
		`Coordinates are in ${SESSION_SHOT_WIDTH}x${(SESSION_SHOT_WIDTH * 9) / 16} screenshot pixels.`,
	].join("\n")

/** Prints the verdict in `dir` and returns its exit code. */
const verdictIn = (dir: string) =>
	requireRunFile(dir, RUN_FILES.verdict, VerdictFile).pipe(
		Effect.tap((v) => printVerdict("", v)),
		Effect.tap(() => Console.log(`run dir: ${dir}`)),
		Effect.map(exitCodeOf)
	)

/**
 * Waits past `since` for the next side or the end of the run. Prints the verdict of
 * the side that just ended (`ended`), and returns the exit code to leave with.
 */
const followSession = Effect.fnUntraced(function* (
	runDir: string,
	client: Effect.Success<ReturnType<typeof connect>>,
	since: number,
	ended: Option.Option<Ready>
) {
	let seq = since
	for (;;) {
		const s = yield* client.status(seq)
		seq = s.seq
		if (s._tag === "Booting") {
			continue
		}
		if (Option.isSome(ended)) {
			yield* verdictIn(ended.value.runDir)
		}
		if (s._tag === "Ready") {
			yield* Console.log(readyText(s))
			return 0
		}
		// The change's verdict is the one that counts; print it unless it was just printed.
		if (Option.exists(ended, (e) => e.side !== "before")) {
			return exitCodeOf(yield* requireRunFile(runDir, RUN_FILES.verdict, VerdictFile))
		}
		return yield* verdictIn(runDir)
	}
})

/** `witness act`: sends one command to an open session. Returns the exit code. */
export const act = Effect.fn("act")(function* (opts: {
	readonly action: ActionName
	readonly args: readonly string[]
	readonly label: Option.Option<string>
	readonly run: Option.Option<string>
	readonly runsDir: string
}) {
	const runDir = yield* findSession(opts.run, opts.runsDir)
	const client = yield* connect(runDir)
	const before = opts.action === "finish" ? yield* client.status(-1) : undefined
	const res = yield* client.act({
		action: opts.action,
		args: opts.args,
		...Option.match(opts.label, { onNone: () => ({}), onSome: (label) => ({ label }) }),
	})
	if (!res.ok) {
		yield* Console.error(`error: ${res.error ?? "unknown"}`)
		return EXIT_ERROR
	}
	if (res.text) {
		yield* Console.log(res.text)
	}
	if (res.shot) {
		yield* Console.log(`screenshot: ${res.shot}`)
	}
	if (!before) {
		return 0
	}
	const ended = before._tag === "Ready" ? Option.some(before) : Option.none<Ready>()
	if (Option.exists(ended, (e) => e.side === "before")) {
		yield* Console.log(`\nrecording the base commit, then booting the change (log: ${runDir}/session.log)`)
	}
	return yield* followSession(runDir, client, before.seq, ended)
})

/** Env var that marks the detached process that actually runs the session. */
export const DAEMON_ENV = "WITNESS_SESSION_RUN_ID"

/**
 * Re-runs this command detached with a fixed run id, follows its log until the
 * session is ready or the run ends, and returns the exit code for the caller.
 */
export const launchSession = Effect.fn("launchSession")(function* (runsDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const id = newRunId(new Date(yield* Clock.currentTimeMillis))
	const dir = path.join(runsDir, id)
	yield* fs.makeDirectory(dir, { recursive: true })
	const logFile = path.join(dir, "session.log")
	const exited = yield* Deferred.make<number | null>()
	yield* Effect.sync(() => {
		const out = openSync(logFile, "a")
		const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
			detached: true,
			env: { ...process.env, [DAEMON_ENV]: id },
			stdio: ["ignore", out, out],
		})
		child.on("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)))
		child.unref()
	})
	yield* Console.log(`run dir: ${dir}\nbooting (log: ${logFile})`)

	// Echo the log until the process opens its endpoint (or dies first).
	const printed = yield* Ref.make(0)
	const follow = Effect.gen(function* () {
		const log = yield* fs.readFileString(logFile).pipe(Effect.orElseSucceed(() => ""))
		const from = yield* Ref.getAndSet(printed, log.length)
		if (log.length > from) {
			yield* Console.log(log.slice(from).trimEnd())
		}
	})
	while (!(yield* fs.exists(path.join(dir, RUN_FILES.driver)))) {
		yield* follow
		if (yield* Deferred.isDone(exited)) {
			yield* Console.error(
				`the session process exited (${yield* Deferred.await(exited)}) before it was ready; see ${logFile}`
			)
			return EXIT_ERROR
		}
		yield* Effect.sleep("500 millis")
	}
	const client = yield* connect(dir)
	const watched = followSession(dir, client, 0, Option.none()).pipe(
		Effect.raceFirst(Effect.forever(follow.pipe(Effect.andThen(Effect.sleep("500 millis")))))
	)
	return yield* watched.pipe(Effect.tap(() => follow))
})
