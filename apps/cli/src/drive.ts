// `witness drive <runDir> <action> [args...]`: hand-drive a kept computer
// (run --keep wrote session.json) while exploring an app before writing a
// walkthrough. Screenshots go to <runDir>/explore/NN.png (1280 wide).
import { makeControlClient } from "@witness/computer"
import { Console, Effect, FileSystem, Path, Schema } from "effect"

const Session = Schema.Struct({ url: Schema.String, token: Schema.String })

/** The run has no session.json, or an argument is missing. */
export class DriveError extends Schema.TaggedError<DriveError>()("DriveError", { message: Schema.String }) {}

export const drive = Effect.fn("drive")(function* (runDir: string, action: string, args: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const dir = path.resolve(runDir)
	const session = yield* fs.readFileString(path.join(dir, "session.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Session))),
		Effect.mapError(() => new DriveError({ message: `no session.json in ${dir}; start the run with --keep` }))
	)
	const c = yield* makeControlClient(session.url, session.token)
	const arg = (i: number, name: string) => (args[i] === undefined ? Effect.fail(new DriveError({ message: `missing <${name}>` })) : Effect.succeed(args[i]!))
	const small = { width: 320, format: "jpeg" as const }

	const shot = Effect.gen(function* () {
		const out = path.join(dir, "explore")
		yield* fs.makeDirectory(out, { recursive: true })
		const n = (yield* fs.readDirectory(out)).filter((f) => f.endsWith(".png")).length + 1
		const s = yield* c.screenshot({ width: 1280 })
		const file = path.join(out, `${String(n).padStart(2, "0")}.png`)
		yield* fs.writeFile(file, s.data)
		yield* Console.log(file)
	})

	switch (action) {
		case "shot":
			return yield* shot
		case "snapshot": {
			const s = yield* c.pageSnapshot(8000)
			yield* Console.log(`URL: ${s.url}\nTitle: ${s.title}\n--- text\n${s.text}\n--- elements`)
			for (const e of s.elements) yield* Console.log(`${e.ref} ${e.role ?? e.tag}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(e.name)} @(${e.x},${e.y})${e.disabled ? " disabled" : ""}`)
			return
		}
		case "click":
			yield* c.act({ action: { type: "click", x: Number(yield* arg(0, "x")), y: Number(yield* arg(1, "y")) }, shot: small })
			return yield* shot
		case "click-text": {
			const want = args.join(" ").toLowerCase()
			const el = (yield* c.pageSnapshot(100)).elements.find((e) => e.name.toLowerCase().includes(want))
			if (!el) return yield* new DriveError({ message: `no element named like "${want}"` })
			yield* c.act({ action: { type: "click", x: el.x, y: el.y }, shot: small })
			yield* Console.log(`clicked ${el.ref} ${JSON.stringify(el.name)} @(${el.x},${el.y})`)
			return yield* shot
		}
		case "type":
			yield* c.act({ action: { type: "type", text: args.join(" ") }, shot: small })
			return yield* shot
		case "key":
			yield* c.act({ action: { type: "key", combo: args.join(" ") }, shot: small })
			return yield* shot
		case "scroll":
			yield* c.act({ action: { type: "scroll", dy: Number(yield* arg(0, "dy")) }, shot: small })
			return yield* shot
		case "navigate":
			yield* Console.log(JSON.stringify(yield* c.navigate(yield* arg(0, "url"), 60_000)))
			return yield* shot
		case "console":
			return yield* Console.log(JSON.stringify(yield* c.consoleMessages, null, 1))
		case "network":
			return yield* Console.log(JSON.stringify(yield* c.networkEvents, null, 1))
		case "logs":
			return yield* Console.log(yield* c.logs(args[0] ?? "app.log", Number(args[1] ?? 100)))
		case "eval":
			return yield* Console.log(JSON.stringify(yield* c.evaluate(args.join(" ")), null, 1))
		default:
			return yield* new DriveError({ message: `unknown action ${action}` })
	}
})
