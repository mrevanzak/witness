// M4 acceptance for a failing run: polished.mp4 < 60 s, a zoom on every click
// (played at 1x), and a freeze on the failing criterion. Writes render/sheet.png.
//   pnpm acceptance:phase4 runs/<id>
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Step, Verdict } from "@witness/domain"
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { outputTimeOf, renderRun, sourceTimeAt, zoomAt } from "../src/index.ts"

class AcceptanceFailed extends Schema.TaggedError<AcceptanceFailed>()("AcceptanceFailed", { message: Schema.String }) {}

const CLICKS = new Set(["click", "double_click", "right_click", "click_element"])

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const dir = path.resolve(process.argv[2] ?? "")
	const r = yield* renderRun(dir)
	const tl = r.timeline
	const problems: Array<string> = []
	if (r.durationSec >= 60) problems.push(`polished.mp4 is ${r.durationSec.toFixed(1)} s (>= 60)`)

	const lines = (yield* fs.readFileString(path.join(dir, "steps.jsonl"))).split("\n").filter(Boolean)
	const steps = yield* Effect.forEach(lines, (l) => Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(l))
	const clicks = steps.filter((s) => CLICKS.has(s.tool) && s.t !== undefined && s.x !== undefined && s.y !== undefined)
	for (const c of clicks) {
		const out = outputTimeOf(tl, c.t!)
		if (out === null) {
			problems.push(`click at ${c.t}s is not in the video`)
			continue
		}
		const { segment } = sourceTimeAt(tl, Math.floor(out * tl.fps))
		const z = zoomAt(tl.zoom, c.t!)
		if (segment.kind !== "video" || segment.rate !== 1) problems.push(`click at ${c.t}s plays at ${segment.kind === "video" ? segment.rate : segment.kind}`)
		if (z.scale < 1.7) problems.push(`click at ${c.t}s not zoomed (scale ${z.scale.toFixed(2)})`)
		if (Math.abs(z.cx - c.x!) > tl.screen.w / (2 * z.scale) || Math.abs(z.cy - c.y!) > tl.screen.h / (2 * z.scale)) problems.push(`click at ${c.t}s is outside the zoomed view`)
	}
	const verdict = yield* fs.readFileString(path.join(dir, "verdict.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Verdict))))
	for (const c of verdict.criteria.filter((x) => x.status === "fail")) {
		if (!tl.segments.some((s) => s.kind === "freeze" && s.criterion === c.id)) problems.push(`no freeze for failing ${c.id}`)
	}

	// Contact sheet: each click, every freeze, the end card.
	const times = [...clicks.flatMap((c) => { const t = outputTimeOf(tl, c.t!); return t === null ? [] : [t] }), ...tl.segments.filter((s) => s.kind !== "video").map((s) => (s.from + s.frames / 2) / tl.fps)].slice(0, 12)
	const tiles: Array<string> = []
	for (const [i, t] of times.entries()) {
		const p = path.join(dir, "render", `tile${i}.png`)
		yield* spawner.string(ChildProcess.make("ffmpeg", ["-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", r.polished, "-frames:v", "1", "-vf", "scale=640:-1", p]))
		tiles.push(p)
	}
	const cols = 3
	const rows = Math.ceil(tiles.length / cols)
	while (tiles.length < rows * cols) tiles.push(tiles[tiles.length - 1]!)
	const rowF = Array.from({ length: rows }, (_, row) => `${Array.from({ length: cols }, (_, c) => `[${row * cols + c}]`).join("")}hstack=inputs=${cols}[r${row}]`).join(";")
	const stack = rows > 1 ? `;${Array.from({ length: rows }, (_, row) => `[r${row}]`).join("")}vstack=inputs=${rows}` : ""
	yield* spawner.string(ChildProcess.make("ffmpeg", ["-loglevel", "error", "-y", ...tiles.flatMap((t) => ["-i", t]), "-filter_complex", `${rowF}${stack}`, ...(rows > 1 ? [] : ["-map", "[r0]"]), path.join(dir, "render", "sheet.png")]))

	yield* Console.log(`polished ${r.durationSec.toFixed(1)} s from ${tl.sourceDuration.toFixed(1)} s raw; ${clicks.length} clicks; ${tl.segments.filter((s) => s.kind === "freeze").length} freeze(s)`)
	if (problems.length) return yield* new AcceptanceFailed({ message: `M4 render check failed:\n- ${problems.join("\n- ")}` })
	yield* Console.log("M4 render check OK")
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
