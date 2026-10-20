// Screen recording: ffmpeg x11grab -> /artifacts/raw.mkv, stopped with SIGINT so the
// file is finalised, then remuxed to .mp4. `-copyts` keeps x11grab's wall-clock pts,
// so the first packet's pts is the exact capture time of the first frame (t0).
import { Config, Context, Effect, Exit, Layer, Option, Scope, SynchronizedRef } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { RecordingResult } from "../protocol.ts"
import { Artifacts } from "./artifacts.ts"
import type { ArtifactPathError } from "./errors.ts"
import { RecordingError, RecordingStateError } from "./errors.ts"
import { runText } from "./proc.ts"

type Active = {
	readonly handle: ChildProcessSpawner.ChildProcessHandle
	readonly mkv: string
	readonly scope: Scope.Closeable
	readonly startedAt: number
}

export class Recorder extends Context.Service<
	Recorder,
	{
		start: (
			path: string | undefined
		) => Effect.Effect<{ mkv: string; startedAt: number }, RecordingStateError | RecordingError | ArtifactPathError>
		readonly stop: Effect.Effect<RecordingResult, RecordingStateError | RecordingError>
		readonly recording: Effect.Effect<boolean>
	}
>()("witness/computer/server/Recorder") {
	static readonly layer = Layer.effect(
		Recorder,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const artifacts = yield* Artifacts
			const w = yield* Config.Int("SCREEN_WIDTH").pipe(Config.withDefault(1920))
			const h = yield* Config.Int("SCREEN_HEIGHT").pipe(Config.withDefault(1080))
			const state = yield* SynchronizedRef.make<Option.Option<Active>>(Option.none())
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
			const failed = (what: string) => (e: unknown) =>
				new RecordingError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

			const start = Effect.fn("Recorder.start")(function* (path: string | undefined) {
				const mkv = yield* artifacts.resolve(path ?? "raw.mkv")
				return yield* SynchronizedRef.modifyEffect(state, (current) =>
					Effect.gen(function* () {
						if (Option.isSome(current)) {
							return yield* new RecordingStateError({ message: "already recording" })
						}
						// The process outlives this request: it lives in its own scope until stop.
						const scope = yield* Scope.make()
						const args = [
							"-hide_banner",
							"-loglevel",
							"error",
							"-nostdin",
							"-f",
							"x11grab",
							"-draw_mouse",
							"0",
							"-framerate",
							"30",
							"-video_size",
							`${w}x${h}`,
							"-i",
							":1",
							"-copyts",
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-crf",
							"18",
							"-pix_fmt",
							"yuv420p",
							"-y",
							mkv,
						]
						const handle = yield* spawner
							.spawn(ChildProcess.make("ffmpeg", args, { stderr: "ignore", stdin: "ignore", stdout: "ignore" }))
							.pipe(Scope.provide(scope), Effect.mapError(failed("ffmpeg")))
						const startedAt = Date.now()
						const active: Active = { handle, mkv, scope, startedAt }
						return [{ mkv, startedAt }, Option.some(active)] as const
					})
				)
			})

			const finish = Effect.fnUntraced(function* (active: Active) {
				// SIGINT lets ffmpeg write the trailer; SIGKILL only if it ignores us for 5 s.
				yield* active.handle.kill({ forceKillAfter: "5 seconds", killSignal: "SIGINT" }).pipe(Effect.ignore)
				yield* active.handle.exitCode.pipe(Effect.ignore)
				yield* Scope.close(active.scope, Exit.void)
				const firstPts = yield* runText("ffprobe", [
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_entries",
					"packet=pts_time",
					"-read_intervals",
					"%+#1",
					"-of",
					"csv=p=0",
					active.mkv,
				]).pipe(
					provide,
					Effect.mapError(failed("ffprobe")),
					Effect.map((out) => Number.parseFloat(out.split("\n")[0] ?? ""))
				)
				const t0 = Number.isFinite(firstPts) && firstPts > 1e9 ? Math.round(firstPts * 1000) : null
				const mp4 = active.mkv.replace(/\.mkv$/, ".mp4")
				yield* runText("ffmpeg", [
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					active.mkv,
					"-c",
					"copy",
					"-movflags",
					"+faststart",
					mp4,
				]).pipe(provide, Effect.mapError(failed("remux")))
				const duration = yield* runText("ffprobe", [
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"csv=p=0",
					mp4,
				]).pipe(provide, Effect.mapError(failed("ffprobe")), Effect.map(Number.parseFloat))
				return { duration, mkv: active.mkv, mp4, t0 } satisfies RecordingResult
			})

			const stop = SynchronizedRef.modifyEffect(state, (current) =>
				Effect.gen(function* () {
					if (Option.isNone(current)) {
						return yield* new RecordingStateError({ message: "not recording" })
					}
					const result = yield* finish(current.value)
					return [result, Option.none<Active>()] as const
				})
			).pipe(Effect.withSpan("Recorder.stop"))

			// On shutdown (docker stop), finalise a running recording instead of losing it.
			yield* Effect.addFinalizer(() =>
				SynchronizedRef.get(state).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.void,
							onSome: () => stop.pipe(Effect.timeoutOption("2500 millis"), Effect.ignore),
						})
					)
				)
			)

			return Recorder.of({ recording: SynchronizedRef.get(state).pipe(Effect.map(Option.isSome)), start, stop })
		})
	)
}
