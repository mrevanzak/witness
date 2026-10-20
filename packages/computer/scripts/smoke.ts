// M2 acceptance: `pnpm witness:smoke`
//   create a computer -> open Chromium on a local test page -> click a button ->
//   save a still -> stop in < 3 s -> raw.mp4 duration matches wall time (±1 s).
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Effect, Exit, FileSystem, Layer, Path, Schema, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ComputerProvider, DockerComputerProvider } from "../src/index.ts"

class SmokeFailed extends Schema.TaggedError<SmokeFailed>()("SmokeFailed", { message: Schema.String }) {}

const PAGE = `<!doctype html><title>witness smoke</title>
<style>body{font:24px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f6}
button{font:inherit;padding:16px 32px;border-radius:12px;border:0;background:#111;color:#fff}</style>
<main><h1 id="status">Not clicked</h1><button id="go" onclick="document.getElementById('status').textContent='Clicked!'">Click me</button></main>`

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const provider = yield* ComputerProvider
	const runId = `smoke-${Date.now().toString(36)}`
	const dir = path.resolve("runs", runId)
	yield* fs.makeDirectory(dir, { recursive: true })
	yield* fs.writeFileString(path.join(dir, "smoke.html"), PAGE)

	const scope = yield* Scope.make()
	const t = yield* Clock.currentTimeMillis
	const computer = yield* provider.create({ runId, artifactsDir: dir }).pipe(Scope.provide(scope))
	yield* Effect.logInfo(`created ${computer.id.slice(0, 12)} on ${computer.network} in ${(yield* Clock.currentTimeMillis) - t} ms`)

	const recStart = yield* Clock.currentTimeMillis
	yield* computer.startRecording("raw.mkv")
	const nav = yield* computer.navigate("file:///artifacts/smoke.html")
	if (nav.error) return yield* new SmokeFailed({ message: `navigate: ${nav.error}` })
	const before = yield* computer.pageSnapshot()
	const button = before.elements.find((e) => e.name === "Click me")
	if (!button) return yield* new SmokeFailed({ message: "button not in snapshot" })

	yield* computer.act({ action: { type: "wait", ms: 800 } })
	const shot = yield* computer.act({ action: { type: "click", x: button.x, y: button.y } })
	yield* fs.writeFile(path.join(dir, "after-click.png"), shot.data)
	const after = yield* computer.pageSnapshot()
	if (!after.text.includes("Clicked!")) return yield* new SmokeFailed({ message: `click did not land: ${after.text.slice(0, 200)}` })
	yield* Effect.logInfo(`clicked at (${button.x}, ${button.y}); cursor (${shot.cursor.x}, ${shot.cursor.y})`)
	yield* computer.act({ action: { type: "wait", ms: 1500 } })

	const recStop = yield* Clock.currentTimeMillis
	const result = yield* computer.stopRecording
	const wall = (recStop - recStart) / 1000
	yield* Effect.logInfo(`recording ${result.duration.toFixed(2)} s for ${wall.toFixed(2)} s wall; t0 ${result.t0}`)
	if (Math.abs(result.duration - wall) > 1) return yield* new SmokeFailed({ message: `duration ${result.duration} vs wall ${wall}` })
	const probed = yield* spawner.string(ChildProcess.make("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "raw.mp4")]))
	if (!(Number(probed) > 0)) return yield* new SmokeFailed({ message: "raw.mp4 is not playable" })

	const s = yield* Clock.currentTimeMillis
	yield* Scope.close(scope, Exit.void)
	const took = (yield* Clock.currentTimeMillis) - s
	yield* Effect.logInfo(`destroyed in ${took} ms`)
	const left = yield* spawner.lines(ChildProcess.make("docker", ["ps", "-aq", "--filter", `label=witness.run=${runId}`]))
	if (left.filter(Boolean).length) return yield* new SmokeFailed({ message: `left ${left.length} containers behind` })
	if (took > 3000) return yield* new SmokeFailed({ message: `stop took ${took} ms (> 3 s)` })
	yield* Effect.logInfo(`SMOKE OK -> ${dir}`)
})

program.pipe(
	Effect.provide(DockerComputerProvider.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)))),
	NodeRuntime.runMain
)
