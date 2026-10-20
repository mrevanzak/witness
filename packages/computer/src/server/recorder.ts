// Screen recording: ffmpeg x11grab -> /artifacts/raw.mkv, stopped with SIGINT so the
// file is finalised, then remuxed to raw.mp4. `-copyts` keeps x11grab's wall-clock
// pts, so the first packet's pts is the exact capture time of the first frame (t0).
import { Context, Duration, Effect, Exit, Layer, Option, Scope, SynchronizedRef } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { messageOf } from "../message.ts"
import {
	DISPLAY,
	type RecordingResult,
	RecordingStateError,
	type RecordStartResult,
	SCREEN,
	ServerError,
	SHUTDOWN_GRACE_SECONDS,
} from "../protocol.ts"
import { ARTIFACTS } from "./artifacts.ts"
import { runText } from "./proc.ts"

const MKV = `${ARTIFACTS}/raw.mkv`
const MP4 = `${ARTIFACTS}/raw.mp4`

type Active = {
	/** Owns ffmpeg; closing it SIGINTs ffmpeg and waits until raw.mkv is finalised. */
	readonly scope: Scope.Closeable
	readonly startedAt: number
}

export class Recorder extends Context.Service<
	Recorder,
	{
		readonly start: Effect.Effect<RecordStartResult, RecordingStateError | ServerError>
		readonly stop: Effect.Effect<RecordingResult, RecordingStateError | ServerError>
		readonly recording: Effect.Effect<boolean>
	}
>()("witness/computer/server/Recorder") {
	static readonly layer = Layer.effect(
		Recorder,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const layerScope = yield* Effect.scope
			const state = yield* SynchronizedRef.make<Option.Option<Active>>(Option.none())
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
			const failed = (what: string) => (e: unknown) => new ServerError({ message: `${what}: ${messageOf(e)}` })

			const start = SynchronizedRef.modifyEffect(state, (current) =>
				Effect.gen(function* () {
					if (Option.isSome(current)) {
						return yield* new RecordingStateError({ message: "already recording" })
					}
					// ffmpeg outlives this request: it lives in a child of the layer scope until stop (or shutdown).
					const scope = yield* Scope.fork(layerScope)
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
						`${SCREEN.width}x${SCREEN.height}`,
						"-i",
						DISPLAY,
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
						MKV,
					]
					yield* spawner
						.spawn(
							ChildProcess.make("ffmpeg", args, {
								// Releasing the scope SIGINTs ffmpeg so it writes the trailer; SIGKILL only past the budget.
								forceKillAfter: Duration.seconds(SHUTDOWN_GRACE_SECONDS),
								killSignal: "SIGINT",
								stderr: "ignore",
								stdin: "ignore",
								stdout: "ignore",
							})
						)
						.pipe(
							Scope.provide(scope),
							Effect.tapError(() => Scope.close(scope, Exit.void)),
							Effect.mapError(failed("ffmpeg"))
						)
					const startedAt = Date.now()
					return [{ mkv: MKV, startedAt }, Option.some({ scope, startedAt })] as const
				})
			).pipe(Effect.withSpan("Recorder.start"))

			const finish = Effect.fnUntraced(function* (active: Active) {
				// Uninterruptible: raw.mkv is complete once this returns.
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
					MKV,
				]).pipe(
					provide,
					Effect.mapError(failed("ffprobe")),
					Effect.map((out) => Number.parseFloat(out.split("\n")[0] ?? ""))
				)
				const t0 = Number.isFinite(firstPts) && firstPts > 1e9 ? Math.round(firstPts * 1000) : null
				yield* runText("ffmpeg", [
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					MKV,
					"-c",
					"copy",
					"-movflags",
					"+faststart",
					MP4,
				]).pipe(provide, Effect.mapError(failed("remux")))
				const duration = yield* runText("ffprobe", [
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"csv=p=0",
					MP4,
				]).pipe(provide, Effect.mapError(failed("ffprobe")), Effect.map(Number.parseFloat))
				return { duration, mkv: MKV, mp4: MP4, t0 } satisfies RecordingResult
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

			// On shutdown (docker stop) ffmpeg's scope, a child of the layer scope, has
			// already finalised raw.mkv by the time this runs; remux it as a stop would.
			yield* Effect.addFinalizer(() =>
				SynchronizedRef.get(state).pipe(
					Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: () => Effect.ignore(stop) }))
				)
			)

			return Recorder.of({ recording: SynchronizedRef.get(state).pipe(Effect.map(Option.isSome)), start, stop })
		})
	)
}
