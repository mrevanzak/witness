// `witness run --session`: a live run that the calling Claude Code session drives
// itself. The run boots the app, starts recording, then serves a local command
// endpoint; `witness act <action>` sends one recorded action at a time (click,
// type, begin/end a criterion, take a still) and prints a screenshot path to look
// at. `witness act finish` closes it and the run writes its verdict as usual.
//
// `run --session` detaches the run into a background process and returns once
// the session is ready (or the app failed to boot), so the caller needs no
// background shell.

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { openSync } from "node:fs"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { type PageElement, SCREEN_W } from "@witness/computer"
import { CriterionKind, CriterionStatus, EXIT_CODES } from "@witness/domain"
import { newRunId, Walkthrough, type WalkthroughProgram, WalkthroughStepFailed } from "@witness/orchestrator"
import { Clock, Console, Deferred, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Semaphore } from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { freePort } from "./live.ts"

/** Screenshots the driver sees are this wide; coordinates it sends and reads are in these pixels. */
const SHOT_W = 1280
const SCALE = SCREEN_W / SHOT_W
const toScreen = (v: number) => Math.round(v * SCALE)
const toShot = (v: number) => Math.round(v / SCALE)

/** Written to <runDir>/driver.json while the session is open; removed when it closes. */
const DriverInfo = Schema.Struct({ token: Schema.String, url: Schema.String })
const DriverInfoJson = Schema.fromJsonString(DriverInfo)

const ActRequest = Schema.Struct({
	action: Schema.String,
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

/** No session to talk to, or a command was malformed. */
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", { message: Schema.String }) {}

export const ACTIONS = [
	"criterion",
	"begin",
	"end",
	"shot",
	"snapshot",
	"click",
	"click-ref",
	"click-text",
	"type",
	"type-secret",
	"key",
	"scroll",
	"navigate",
	"wait",
	"eval",
	"console",
	"logs",
	"still",
	"note",
	"preview",
	"intro",
	"finish",
] as const

const fail = (message: string) => new WalkthroughStepFailed({ message })

/** The walkthrough program behind `run --session`: serves commands until `finish` or `idleMs` without one. */
export const sessionProgram = Effect.fnUntraced(function* (idleMs: number) {
	const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
	const program = Effect.gen(function* () {
		const w = yield* Walkthrough
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const lock = yield* Semaphore.make(1)
		const done = yield* Deferred.make<void>()
		const lastAt = yield* Ref.make(yield* Clock.currentTimeMillis)
		const elements = yield* Ref.make(new Map<string, PageElement>())
		const shotNo = yield* Ref.make(0)
		const shotDir = path.join(w.runDir, "session")
		const io = (e: { readonly message: string }) => fail(e.message)
		yield* fs.makeDirectory(shotDir, { recursive: true }).pipe(Effect.mapError(io))

		const look = Effect.gen(function* () {
			const s = yield* w.screenshot({ format: "jpeg", quality: 80, width: SHOT_W })
			const n = yield* Ref.updateAndGet(shotNo, (x) => x + 1)
			const file = path.join(shotDir, `${String(n).padStart(3, "0")}.jpg`)
			yield* fs.writeFile(file, s.data).pipe(Effect.mapError(io))
			return file
		})

		const perform = Effect.fnUntraced(function* (req: typeof ActRequest.Type) {
			const { action, args } = req
			const rest = args.join(" ")
			const need = (i: number, name: string): Effect.Effect<string, WalkthroughStepFailed> =>
				args[i] === undefined ? Effect.fail(fail(`${action}: missing <${name}>`)) : Effect.succeed(args[i]!)
			const int = (i: number, name: string): Effect.Effect<number, WalkthroughStepFailed> =>
				need(i, name).pipe(
					Effect.flatMap((v) =>
						Number.isFinite(Number(v))
							? Effect.succeed(Math.round(Number(v)))
							: Effect.fail(fail(`${name}: not a number`))
					)
				)
			const label = (fallback: string) => req.label ?? fallback
			const shown = (text?: string) => ({ shot: true, text })

			switch (action) {
				case "criterion": {
					const id = yield* need(0, "id")
					const kind = yield* need(1, "feature|regression")
					if (!Schema.is(CriterionKind)(kind)) {
						return yield* fail("kind must be feature or regression")
					}
					const description = args.slice(2).join(" ")
					if (!description) {
						return yield* fail("criterion: missing <description>")
					}
					yield* w.criterion(id, kind, description)
					return { text: `declared ${id} (${kind})` }
				}
				case "begin":
					yield* w.begin(yield* need(0, "id"))
					return { text: "begun" }
				case "end": {
					const id = yield* need(0, "id")
					const status = yield* need(1, "pass|fail|blocked")
					if (!Schema.is(CriterionStatus)(status)) {
						return yield* fail("status must be pass, fail or blocked")
					}
					const notes = args.slice(2).join(" ")
					if (!notes) {
						return yield* fail("end: missing <notes> (what you did and saw)")
					}
					yield* w.end(id, status, notes)
					return { text: `${id} ${status}` }
				}
				case "shot":
					return shown()
				case "snapshot": {
					const snap = yield* w.snapshot(8000)
					yield* Ref.set(elements, new Map(snap.elements.map((e) => [e.ref, e])))
					const lines = snap.elements.map((e) => {
						const flags = [e.disabled ? "disabled" : "", e.checked ? "checked" : ""].filter(Boolean).join(",")
						return `${e.ref} ${e.role ?? e.tag}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(e.name)}${e.value ? ` value=${JSON.stringify(e.value)}` : ""}${flags ? ` (${flags})` : ""} @(${toShot(e.x)},${toShot(e.y)})`
					})
					return {
						text: `URL: ${snap.url}\nTitle: ${snap.title}\n--- text\n${snap.text}\n--- elements\n${lines.join("\n")}`,
					}
				}
				case "click": {
					const x = yield* int(0, "x")
					const y = yield* int(1, "y")
					yield* w.click(toScreen(x), toScreen(y), label(`Click at (${x}, ${y})`))
					return shown()
				}
				case "click-ref": {
					const ref = yield* need(0, "ref")
					const el = (yield* Ref.get(elements)).get(ref)
					if (!el) {
						return yield* fail(`unknown ref ${ref}; run snapshot first (refs change after every snapshot)`)
					}
					yield* w.click(el.x, el.y, label(`Click "${el.name.slice(0, 40)}"`))
					return shown(`clicked ${ref} ${JSON.stringify(el.name)}`)
				}
				case "click-text": {
					if (!rest) {
						return yield* fail("click-text: missing <text>")
					}
					const el = yield* w.clickText(rest, label(`Click "${rest.slice(0, 40)}"`), { timeoutMs: 5000 })
					return shown(`clicked ${el.ref} ${JSON.stringify(el.name)}`)
				}
				case "type":
					yield* w.type(rest, label(`Type "${rest.slice(0, 30)}"`))
					return shown()
				case "type-secret":
					yield* w.typeSecret(label("Type the password"))
					return shown()
				case "key": {
					const combo = yield* need(0, "combo")
					yield* w.key(combo, label(`Press ${combo}`))
					return shown()
				}
				case "scroll": {
					const dy = yield* int(0, "dy")
					const at = args.length >= 3 ? { x: toScreen(yield* int(1, "x")), y: toScreen(yield* int(2, "y")) } : undefined
					yield* w.scroll(dy, label(dy > 0 ? "Scroll down" : "Scroll up"), at)
					return shown()
				}
				case "navigate": {
					const url = yield* need(0, "url")
					yield* w.navigate(new URL(url, w.config.url).toString(), label(`Open ${new URL(url, w.config.url).pathname}`))
					return shown()
				}
				case "wait": {
					const ms = Math.max(100, Math.min(10_000, yield* int(0, "ms")))
					yield* w.wait(ms, req.label)
					return shown()
				}
				case "eval":
					return { text: String(JSON.stringify(yield* w.evaluate(rest), null, 1)) }
				case "console": {
					const logs = yield* w.browserLogs
					return { text: JSON.stringify(logs, null, 1) }
				}
				case "logs":
					return { text: yield* w.appLogs(args[1] ?? "app.log", Number(args[0] ?? 100)) }
				case "still": {
					const name = yield* need(0, "name")
					const caption = args.slice(1).join(" ")
					if (!caption) {
						return yield* fail("still: missing <caption> (one sentence saying what it proves)")
					}
					return { text: yield* w.still(name.replace(/[^\w-]+/g, "-"), caption) }
				}
				case "note":
					yield* w.note(rest)
					return { text: "noted" }
				case "preview":
					yield* w.preview(rest)
					return { text: "set" }
				case "intro":
					yield* w.intro(rest)
					return { text: "set" }
				case "finish":
					yield* Deferred.succeed(done, undefined)
					return { text: "finishing" }
				default:
					return yield* fail(`unknown action ${action}; one of ${ACTIONS.join(", ")}`)
			}
		})

		const handle = (req: typeof ActRequest.Type) =>
			Effect.gen(function* () {
				yield* Ref.set(lastAt, yield* Clock.currentTimeMillis)
				const r: { readonly text?: string | undefined; readonly shot?: boolean } = yield* perform(req)
				const shot = r.shot ? yield* look : undefined
				yield* Ref.set(lastAt, yield* Clock.currentTimeMillis)
				return { ok: true, ...(shot ? { shot } : {}), ...(r.text ? { text: r.text } : {}) } satisfies ActResponse
			}).pipe(
				Effect.catch((e) => Effect.succeed({ error: e.message, ok: false } satisfies ActResponse)),
				Semaphore.withPermit(lock)
			)

		const token = randomBytes(24).toString("hex")
		const routes = HttpRouter.add(
			"POST",
			"/act",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				if (request.headers.authorization !== `Bearer ${token}`) {
					return yield* HttpServerResponse.json({ error: "unauthorized", ok: false }, { status: 401 })
				}
				const body = yield* HttpServerRequest.schemaBodyJson(ActRequest).pipe(Effect.option)
				if (Option.isNone(body)) {
					return yield* HttpServerResponse.json({ error: "bad request", ok: false }, { status: 400 })
				}
				return yield* HttpServerResponse.json(yield* handle(body.value))
			}).pipe(Effect.orDie)
		)
		const port = yield* freePort
		yield* Layer.launch(
			HttpRouter.serve(routes, { disableLogger: true }).pipe(
				Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }))
			)
		).pipe(Effect.forkScoped)

		const driverFile = path.join(w.runDir, "driver.json")
		yield* Effect.acquireRelease(
			fs
				.writeFileString(driverFile, Schema.encodeSync(DriverInfoJson)({ token, url: `http://127.0.0.1:${port}` }))
				.pipe(Effect.mapError(io)),
			() => fs.remove(driverFile).pipe(Effect.ignore)
		)
		yield* Console.log(`session ready: ${w.runDir}`)

		const idle = Effect.gen(function* () {
			for (;;) {
				yield* Effect.sleep("5 seconds")
				if ((yield* Clock.currentTimeMillis) - (yield* Ref.get(lastAt)) > idleMs) {
					return yield* fail(`no command for ${Math.round(idleMs / 1000)} s; the session closed itself`)
				}
			}
		})
		yield* Effect.raceFirst(Deferred.await(done), idle)
		// Let the `finish` reply go out before the server closes.
		yield* Effect.sleep("300 millis")
	}).pipe(Effect.scoped, Effect.provideContext(context))
	return program as WalkthroughProgram
})

/** Finds the run to talk to: `run`, or the newest run under `runsDir` with an open session. */
const findSession = Effect.fnUntraced(function* (run: Option.Option<string>, runsDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	if (Option.isSome(run)) {
		return path.resolve(run.value)
	}
	const root = path.resolve(runsDir)
	const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]))
	for (const name of [...names].sort().reverse()) {
		if (yield* fs.exists(path.join(root, name, "driver.json")).pipe(Effect.orElseSucceed(() => false))) {
			return path.join(root, name)
		}
	}
	return yield* new SessionError({ message: `no open session under ${root}; start one with \`witness run --session\`` })
})

const printVerdict = Effect.fnUntraced(function* (runDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const raw = yield* fs.readFileString(path.join(runDir, "verdict.json"))
	const v = JSON.parse(raw) as {
		overall: "pass" | "fail" | "blocked"
		notes?: string
		criteria?: { id: string; status: string; description: string }[]
	}
	yield* Console.log(`\n${v.overall.toUpperCase()}`)
	for (const c of v.criteria ?? []) {
		yield* Console.log(`  ${c.id} ${c.status.padEnd(7)} ${c.description}`)
	}
	if (!v.criteria && v.notes) {
		yield* Console.log(`  ${v.notes}`)
	}
	yield* Console.log(`run dir: ${runDir}`)
	return EXIT_CODES[v.overall]
})

/** Waits up to `timeoutMs` for `file` to exist. */
const waitFor = (file: string, timeoutMs: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
		while ((yield* Clock.currentTimeMillis) < deadline) {
			if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
				return true
			}
			yield* Effect.sleep("500 millis")
		}
		return false
	})

/** `witness act`: sends one command to an open session. Returns the exit code. */
export const act = Effect.fn("act")(function* (opts: {
	readonly action: string
	readonly args: readonly string[]
	readonly label: Option.Option<string>
	readonly run: Option.Option<string>
	readonly runsDir: string
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const runDir = yield* findSession(opts.run, opts.runsDir)
	const info = yield* fs.readFileString(path.join(runDir, "driver.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(DriverInfoJson)),
		Effect.mapError(() => new SessionError({ message: `no open session in ${runDir}` }))
	)
	const body = {
		action: opts.action,
		args: opts.args,
		...(Option.isSome(opts.label) ? { label: opts.label.value } : {}),
	}
	const req = yield* HttpClientRequest.post(`${info.url}/act`).pipe(
		HttpClientRequest.bearerToken(info.token),
		HttpClientRequest.bodyJson(body)
	)
	const res = yield* HttpClient.execute(req).pipe(
		Effect.flatMap(HttpClientResponse.schemaBodyJson(ActResponse)),
		Effect.timeout("150 seconds"),
		Effect.mapError((e) => new SessionError({ message: `session in ${runDir} did not answer: ${e.message}` }))
	)
	if (!res.ok) {
		yield* Console.error(`error: ${res.error ?? "unknown"}`)
		return 1
	}
	if (res.text) {
		yield* Console.log(res.text)
	}
	if (res.shot) {
		yield* Console.log(`screenshot: ${res.shot}`)
	}
	if (opts.action !== "finish") {
		return 0
	}
	if (!(yield* waitFor(path.join(runDir, "verdict.json"), 120_000))) {
		return yield* new SessionError({ message: `no verdict.json in ${runDir} after 2 minutes; see session.log` })
	}
	return yield* printVerdict(runDir)
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
	const exited: { code?: number | null } = {}
	yield* Effect.sync(() => {
		const out = openSync(logFile, "a")
		const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
			detached: true,
			env: { ...process.env, [DAEMON_ENV]: id },
			stdio: ["ignore", out, out],
		})
		child.on("exit", (code) => {
			exited.code = code
		})
		child.unref()
	})
	yield* Console.log(`run dir: ${dir}\nbooting (log: ${logFile})`)

	let printed = 0
	const follow = Effect.gen(function* () {
		const text = yield* fs.readFileString(logFile).pipe(Effect.orElseSucceed(() => ""))
		if (text.length > printed) {
			yield* Console.log(text.slice(printed).trimEnd())
			printed = text.length
		}
	})
	for (;;) {
		yield* follow
		if (yield* fs.exists(path.join(dir, "driver.json"))) {
			yield* Console.log(
				[
					"",
					"SESSION READY. Drive it with `witness act <action> [args] [--label <caption>]`:",
					"  criterion <id> feature|regression <description>   begin <id>   end <id> pass|fail|blocked <notes>",
					"  shot | snapshot | click <x> <y> | click-ref <ref> | click-text <text> | type <text> | type-secret",
					"  key <combo> | scroll <dy> [x y] | navigate <url> | wait <ms> | eval <js> | console | logs [tail]",
					"  still <name> <caption> | note <line> | preview <line> | intro <line> | finish",
					`Coordinates are in ${SHOT_W}x${(SHOT_W * 9) / 16} screenshot pixels.`,
				].join("\n")
			)
			return 0
		}
		if (yield* fs.exists(path.join(dir, "verdict.json"))) {
			yield* Effect.sleep("300 millis")
			yield* follow
			return yield* printVerdict(dir)
		}
		if ("code" in exited) {
			yield* follow
			yield* Console.error(`the session process exited (${exited.code}) before it was ready; see ${logFile}`)
			return 3
		}
		yield* Effect.sleep("500 millis")
	}
})
