// The actions `witness act` takes: each one's arguments, and the recorded calls
// it makes on the session's recorder. Help text and argument checks come from here.
import { Criterion, CriterionKind, CriterionStatus } from "@witness/domain"
import { ActionFailed, ToolCall } from "@witness/orchestrator"
import { Effect, Option, Schema } from "effect"

type Parse = (args: readonly string[], label: Option.Option<string>) => Effect.Effect<readonly ToolCall[], ActionFailed>
type ActionSpec = { readonly usage: string; readonly parse: Parse }

/** Refuses an action with `message`. */
export const bad = (message: string): Effect.Effect<never, ActionFailed> => Effect.fail(new ActionFailed({ message }))
const need = (action: string, args: readonly string[], i: number, name: string): Effect.Effect<string, ActionFailed> =>
	args[i] === undefined ? bad(`${action}: missing <${name}>`) : Effect.succeed(args[i])
const int = (action: string, args: readonly string[], i: number, name: string): Effect.Effect<number, ActionFailed> =>
	need(action, args, i, name).pipe(
		Effect.flatMap((v) =>
			Number.isFinite(Number(v)) ? Effect.succeed(Math.round(Number(v))) : bad(`${name}: not a number`)
		)
	)
const rest = (args: readonly string[], from = 0) => args.slice(from).join(" ")
const one = (call: ToolCall) => Effect.succeed([call])
const text =
	(action: string, name: string, build: (s: string) => ToolCall): Parse =>
	(args) =>
		rest(args) ? one(build(rest(args))) : bad(`${action}: missing <${name}>`)

/** Every `witness act` action: its arguments, and the recorded calls it makes. */
export const ACTION_SPECS = {
	begin: {
		parse: (args) => need("begin", args, 0, "id").pipe(Effect.map((id) => [ToolCall.Begin({ id })])),
		usage: "begin <id>",
	},
	click: {
		parse: (args, label) =>
			Effect.gen(function* () {
				const x = yield* int("click", args, 0, "x")
				const y = yield* int("click", args, 1, "y")
				return [
					ToolCall.Click({ button: "click", label: Option.getOrElse(label, () => `Click at (${x}, ${y})`), x, y }),
				]
			}),
		usage: "click <x> <y>",
	},
	"click-ref": {
		parse: (args, label) =>
			need("click-ref", args, 0, "ref").pipe(
				Effect.map((ref) => [ToolCall.ClickRef({ label: Option.getOrElse(label, () => ""), ref })])
			),
		usage: "click-ref <ref>",
	},
	"click-text": {
		parse: (args, label) =>
			text("click-text", "text", (t) =>
				ToolCall.ClickText({ label: Option.getOrElse(label, () => `Click "${t.slice(0, 40)}"`), text: t })
			)(args, label),
		usage: "click-text <text>",
	},
	console: { parse: () => Effect.succeed([ToolCall.ConsoleLogs(), ToolCall.NetworkErrors()]), usage: "console" },
	criterion: {
		parse: (args) =>
			Effect.gen(function* () {
				const id = yield* need("criterion", args, 0, "id")
				const kind = yield* need("criterion", args, 1, "feature|regression")
				if (!Schema.is(CriterionKind)(kind)) {
					return yield* bad("kind must be feature or regression")
				}
				const description = rest(args, 2)
				if (!description) {
					return yield* bad("criterion: missing <description>")
				}
				return [ToolCall.Declare({ criterion: new Criterion({ description, id, kind }) })]
			}),
		usage: "criterion <id> feature|regression <description>",
	},
	end: {
		parse: (args) =>
			Effect.gen(function* () {
				const id = yield* need("end", args, 0, "id")
				const status = yield* need("end", args, 1, "pass|fail|blocked")
				if (!Schema.is(CriterionStatus)(status)) {
					return yield* bad("status must be pass, fail or blocked")
				}
				const notes = rest(args, 2)
				if (!notes) {
					return yield* bad("end: missing <notes> (what you did and saw)")
				}
				return [ToolCall.End({ forced: Option.none(), id, notes, status })]
			}),
		usage: "end <id> pass|fail|blocked <notes>",
	},
	eval: { parse: text("eval", "js", (expression) => ToolCall.Evaluate({ expression })), usage: "eval <js>" },
	finish: { parse: () => Effect.succeed([]), usage: "finish" },
	intro: { parse: text("intro", "line", (line) => ToolCall.Intro({ line })), usage: "intro <line>" },
	key: {
		parse: (args, label) =>
			need("key", args, 0, "combo").pipe(
				Effect.map((combo) => [ToolCall.Key({ combo, label: Option.getOrElse(label, () => `Press ${combo}`) })])
			),
		usage: "key <combo>",
	},
	logs: {
		parse: (args) => one(ToolCall.AppLogs({ file: args[1] ?? "app.log", tail: Number(args[0] ?? 100) })),
		usage: "logs [tail] [file]",
	},
	navigate: {
		parse: (args, label) =>
			need("navigate", args, 0, "url").pipe(
				Effect.map((url) => [ToolCall.Navigate({ label: Option.getOrElse(label, () => `Open ${url}`), url })])
			),
		usage: "navigate <url>",
	},
	note: { parse: text("note", "line", (line) => ToolCall.Note({ line })), usage: "note <line>" },
	preview: { parse: text("preview", "line", (line) => ToolCall.Preview({ line })), usage: "preview <line>" },
	scroll: {
		parse: (args, label) =>
			Effect.gen(function* () {
				const dy = yield* int("scroll", args, 0, "dy")
				const at =
					args.length >= 3
						? Option.some({ x: yield* int("scroll", args, 1, "x"), y: yield* int("scroll", args, 2, "y") })
						: Option.none()
				return [
					ToolCall.Scroll({ at, dy, label: Option.getOrElse(label, () => (dy > 0 ? "Scroll down" : "Scroll up")) }),
				]
			}),
		usage: "scroll <dy> [x y]",
	},
	shot: { parse: () => one(ToolCall.Screenshot()), usage: "shot" },
	snapshot: { parse: () => one(ToolCall.Snapshot({ maxText: 8000 })), usage: "snapshot" },
	still: {
		parse: (args) =>
			Effect.gen(function* () {
				const name = yield* need("still", args, 0, "name")
				const caption = rest(args, 1)
				if (!caption) {
					return yield* bad("still: missing <caption> (one sentence saying what it proves)")
				}
				return [ToolCall.Still({ caption, name })]
			}),
		usage: "still <name> <caption>",
	},
	type: {
		parse: (args, label) =>
			one(
				ToolCall.Type({ label: Option.getOrElse(label, () => `Type "${rest(args).slice(0, 30)}"`), text: rest(args) })
			),
		usage: "type <text>",
	},
	"type-secret": {
		parse: (_args, label) => one(ToolCall.TypeSecret({ label: Option.getOrElse(label, () => "Type the password") })),
		usage: "type-secret",
	},
	wait: {
		parse: (args, label) => int("wait", args, 0, "ms").pipe(Effect.map((ms) => [ToolCall.Wait({ label, ms })])),
		usage: "wait <ms>",
	},
} satisfies Record<string, ActionSpec>

export type ActionName = keyof typeof ACTION_SPECS
export const ACTIONS = Object.keys(ACTION_SPECS) as [ActionName, ...ActionName[]]
