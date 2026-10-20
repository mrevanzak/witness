// The X display: screenshots (ImageMagick `import`), cursor and input (xdotool).
import { Config, Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Action, ShotOptions } from "../protocol.ts"
import { DisplayError } from "./errors.ts"
import { runBytes, runText } from "./proc.ts"

export interface Shot {
	readonly data: Uint8Array
	readonly mime: "image/png" | "image/jpeg"
	readonly width: number
	readonly height: number
}

export class Display extends Context.Service<
	Display,
	{
		readonly size: { readonly w: number; readonly h: number }
		screenshot(options: ShotOptions): Effect.Effect<Shot, DisplayError>
		readonly cursor: Effect.Effect<{ readonly x: number; readonly y: number }, DisplayError>
		act(action: Action): Effect.Effect<void, DisplayError>
		readonly healthy: Effect.Effect<boolean>
	}
>()("witness/computer/server/Display") {
	static readonly layer = Layer.effect(
		Display,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const w = yield* Config.Int("SCREEN_WIDTH").pipe(Config.withDefault(1920))
			const h = yield* Config.Int("SCREEN_HEIGHT").pipe(Config.withDefault(1080))
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
			const fail = (what: string) => (e: unknown) => new DisplayError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

			const xdo = (args: ReadonlyArray<string | number>) =>
				runText("xdotool", args.map(String)).pipe(provide, Effect.mapError(fail("xdotool")), Effect.asVoid)
			const clampX = (v: number) => String(Math.max(0, Math.min(w - 1, Math.round(v))))
			const clampY = (v: number) => String(Math.max(0, Math.min(h - 1, Math.round(v))))

			const screenshot = Effect.fn("Display.screenshot")(function* (options: ShotOptions) {
				const width = options.width ?? w
				const height = Math.round((h * width) / w)
				const jpeg = options.format === "jpeg"
				const args = ["-display", ":1", "-window", "root"]
				if (width !== w) args.push("-resize", `${width}x${height}!`)
				if (jpeg) args.push("-quality", String(options.quality ?? 80))
				args.push(jpeg ? "jpg:-" : "png:-")
				const data = yield* runBytes("import", args).pipe(provide, Effect.mapError(fail("screenshot")))
				return { data, mime: jpeg ? "image/jpeg" : "image/png", width, height } satisfies Shot
			})

			const cursor = runText("xdotool", ["getmouselocation", "--shell"]).pipe(
				provide,
				Effect.mapError(fail("cursor")),
				Effect.map((out) => ({ x: Number(out.match(/X=(\d+)/)?.[1] ?? 0), y: Number(out.match(/Y=(\d+)/)?.[1] ?? 0) }))
			)

			const act = Effect.fn("Display.act")(function* (a: Action) {
				switch (a.type) {
					case "move":
						return yield* xdo(["mousemove", clampX(a.x), clampY(a.y)])
					case "click":
					case "double_click":
					case "right_click": {
						const button = a.type === "right_click" ? 3 : a.button === "middle" ? 2 : 1
						const repeat = a.type === "double_click" ? ["--repeat", 2, "--delay", 80] : []
						return yield* xdo(["mousemove", clampX(a.x), clampY(a.y), "click", ...repeat, button])
					}
					case "drag": {
						yield* xdo(["mousemove", clampX(a.x), clampY(a.y), "mousedown", 1])
						const steps = 15
						for (let i = 1; i <= steps; i++) {
							yield* xdo(["mousemove", clampX(a.x + ((a.to_x - a.x) * i) / steps), clampY(a.y + ((a.to_y - a.y) * i) / steps)])
							yield* Effect.sleep("16 millis")
						}
						return yield* xdo(["mouseup", 1])
					}
					case "type":
						return yield* xdo(["type", "--delay", a.delay_ms ?? 18, "--", a.text])
					case "key":
						return yield* xdo(["key", "--clearmodifiers", "--", ...a.combo.split(/\s+/)])
					case "scroll": {
						if (a.x !== undefined && a.y !== undefined) yield* xdo(["mousemove", clampX(a.x), clampY(a.y)])
						const dy = Math.round(a.dy ?? 0)
						const dx = Math.round(a.dx ?? 0)
						if (dy) yield* xdo(["click", "--repeat", Math.min(50, Math.abs(dy)), "--delay", 30, dy > 0 ? 5 : 4])
						if (dx) yield* xdo(["click", "--repeat", Math.min(50, Math.abs(dx)), "--delay", 30, dx > 0 ? 7 : 6])
						return
					}
					case "wait":
						return yield* Effect.sleep(`${a.ms} millis`)
				}
			})

			const healthy = runText("xdpyinfo", ["-display", ":1"]).pipe(provide, Effect.as(true), Effect.orElseSucceed(() => false))

			return Display.of({ size: { w, h }, screenshot, cursor, act, healthy })
		})
	)
}
