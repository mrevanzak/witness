// The X display: screenshots (ImageMagick `import`), cursor and input (xdotool).
import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { messageOf } from "../message.ts"
import { type Action, DISPLAY, SCREEN, type Screenshot, ServerError, type ShotOptions } from "../protocol.ts"
import { runBytes, runText } from "./proc.ts"

/** xdotool button numbers. */
const BUTTON = { left: "1", middle: "2" } as const

/** Actions that drive xdotool (`wait` only sleeps). */
export type InputAction = Exclude<Action, { readonly type: "wait" }>

const DRAG_STEPS = 15
/** Seconds between drag moves (one frame at 60 fps). */
const DRAG_FRAME = "0.016"
const SPACES = /\s+/
const CURSOR_X = /^X=(\d+)$/m
const CURSOR_Y = /^Y=(\d+)$/m

const clampX = (v: number) => String(Math.max(0, Math.min(SCREEN.width - 1, Math.round(v))))
const clampY = (v: number) => String(Math.max(0, Math.min(SCREEN.height - 1, Math.round(v))))

/**
 * One xdotool argv for an action (commands chain; `type` and `key` take the rest
 * of the line, so they come last). Empty when there is nothing to do.
 */
export const toXdo = (a: InputAction): string[] => {
	switch (a.type) {
		case "move":
			return ["mousemove", clampX(a.x), clampY(a.y)]
		case "click":
		case "double_click":
		case "right_click": {
			const button = a.type === "right_click" ? "3" : BUTTON[a.button ?? "left"]
			const repeat = a.type === "double_click" ? ["--repeat", "2", "--delay", "80"] : []
			return ["mousemove", clampX(a.x), clampY(a.y), "click", ...repeat, button]
		}
		case "drag": {
			const steps: string[] = []
			for (let i = 1; i <= DRAG_STEPS; i++) {
				steps.push(
					"mousemove",
					clampX(a.x + ((a.to_x - a.x) * i) / DRAG_STEPS),
					clampY(a.y + ((a.to_y - a.y) * i) / DRAG_STEPS),
					"sleep",
					DRAG_FRAME
				)
			}
			return ["mousemove", clampX(a.x), clampY(a.y), "mousedown", "1", ...steps, "mouseup", "1"]
		}
		case "type":
			return ["type", "--delay", String(a.delay_ms ?? 18), "--", a.text]
		case "key":
			return ["key", "--clearmodifiers", "--", ...a.combo.split(SPACES)]
		case "scroll": {
			const out = a.x !== undefined && a.y !== undefined ? ["mousemove", clampX(a.x), clampY(a.y)] : []
			const wheel = (n: number, up: string, down: string) =>
				n ? ["click", "--repeat", String(Math.min(50, Math.abs(n))), "--delay", "30", n > 0 ? down : up] : []
			return [...out, ...wheel(Math.round(a.dy ?? 0), "4", "5"), ...wheel(Math.round(a.dx ?? 0), "6", "7")]
		}
	}
}

/** Parses `xdotool getmouselocation --shell`; undefined when X or Y is missing. */
export const parseCursor = (out: string): { readonly x: number; readonly y: number } | undefined => {
	const x = out.match(CURSOR_X)?.[1]
	const y = out.match(CURSOR_Y)?.[1]
	return x === undefined || y === undefined ? undefined : { x: Number(x), y: Number(y) }
}

export class Display extends Context.Service<
	Display,
	{
		screenshot: (
			options: ShotOptions
		) => Effect.Effect<Pick<Screenshot, "data" | "height" | "mime" | "width">, ServerError>
		readonly cursor: Effect.Effect<{ readonly x: number; readonly y: number }, ServerError>
		act: (action: Action) => Effect.Effect<void, ServerError>
		readonly healthy: Effect.Effect<boolean>
	}
>()("witness/computer/server/Display") {
	static readonly layer = Layer.effect(
		Display,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
			const fail = (what: string) => (e: unknown) => new ServerError({ message: `${what}: ${messageOf(e)}` })

			const screenshot = Effect.fn("Display.screenshot")(function* (options: ShotOptions) {
				const width = options.width ?? SCREEN.width
				const height = Math.round((SCREEN.height * width) / SCREEN.width)
				const jpeg = options.format === "jpeg"
				const args = ["-display", DISPLAY, "-window", "root"]
				if (width !== SCREEN.width) {
					args.push("-resize", `${width}x${height}!`)
				}
				if (jpeg) {
					args.push("-quality", String(options.quality ?? 80))
				}
				args.push(jpeg ? "jpg:-" : "png:-")
				const data = yield* runBytes("import", args).pipe(provide, Effect.mapError(fail("screenshot")))
				return { data, height, mime: jpeg ? ("image/jpeg" as const) : ("image/png" as const), width }
			})

			const cursor = runText("xdotool", ["getmouselocation", "--shell"]).pipe(
				provide,
				Effect.mapError(fail("cursor")),
				Effect.flatMap((out) => {
					const at = parseCursor(out)
					return at ? Effect.succeed(at) : Effect.fail(new ServerError({ message: `cursor: cannot parse ${out}` }))
				})
			)

			const act = Effect.fn("Display.act")(function* (a: Action) {
				if (a.type === "wait") {
					return yield* Effect.sleep(`${a.ms} millis`)
				}
				const argv = toXdo(a)
				if (argv.length > 0) {
					yield* runText("xdotool", argv).pipe(provide, Effect.mapError(fail("xdotool")))
				}
			})

			const healthy = runText("xdpyinfo", ["-display", DISPLAY]).pipe(
				provide,
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			)

			return Display.of({ act, cursor, healthy, screenshot })
		})
	)
}
