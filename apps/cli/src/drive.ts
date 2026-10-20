// `witness drive <runDir> <command> [args]`: hand-drive a kept computer (session.json)
// while exploring an app before writing a walkthrough. Prints JSON; screenshots go
// to <runDir>/explore/NN.png (downscaled) so a session can look at them.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlClient } from "@witness/computer";

const HELP = `witness drive <runDir> <command>
  shot                       screenshot -> explore/NN.png (1280 wide)
  snapshot                   visible text + interactive elements (screen px)
  click <x> <y>              left click (screen px, 1920x1080)
  click-text <text>          click the first element whose name contains <text>
  type <text> | key <combo>  keyboard (xdotool key syntax)
  scroll <dy> [x y]          wheel notches, positive = down
  navigate <url>             open a URL in the visible tab
  console | network          new console messages / failed requests
  logs [file] [tail]         tail of /artifacts/<file> (default app.log)`;

export async function drive(argv: string[]): Promise<number> {
	const [dirArg, cmd, ...args] = argv;
	if (!dirArg || !cmd) {
		console.error(HELP);
		return 3;
	}
	const dir = resolve(dirArg);
	const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { url: string; token: string };
	const c = new ControlClient(session.url, session.token);
	const print = (v: unknown) => console.log(JSON.stringify(v, null, 1));
	const shot = async () => {
		const out = join(dir, "explore");
		mkdirSync(out, { recursive: true });
		const n = readdirSync(out).filter((f) => f.endsWith(".png")).length + 1;
		const s = await c.screenshot({ width: 1280 });
		const file = join(out, `${String(n).padStart(2, "0")}.png`);
		writeFileSync(file, s.png);
		return file;
	};
	switch (cmd) {
		case "shot":
			console.log(await shot());
			return 0;
		case "snapshot": {
			const s = await c.pageSnapshot(8000);
			console.log(`URL: ${s.url}\nTitle: ${s.title}\n--- text\n${s.text}\n--- elements`);
			for (const e of s.elements) console.log(`${e.ref} ${e.role ?? e.tag}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(e.name)} @(${e.x},${e.y})${e.disabled ? " disabled" : ""}`);
			return 0;
		}
		case "click":
			await c.act({ type: "click", x: Number(args[0]), y: Number(args[1]), shot: { width: 320, format: "jpeg" } });
			console.log(await shot());
			return 0;
		case "click-text": {
			const s = await c.pageSnapshot(100);
			const el = s.elements.find((e) => e.name.toLowerCase().includes(args.join(" ").toLowerCase()));
			if (!el) {
				console.error(`no element named like "${args.join(" ")}"; saw: ${s.elements.map((e) => e.name).filter(Boolean).join(" | ")}`);
				return 1;
			}
			await c.act({ type: "click", x: el.x, y: el.y, shot: { width: 320, format: "jpeg" } });
			console.log(`clicked ${el.ref} ${JSON.stringify(el.name)} @(${el.x},${el.y}) -> ${await shot()}`);
			return 0;
		}
		case "type":
			await c.act({ type: "type", text: args.join(" "), shot: { width: 320, format: "jpeg" } });
			console.log(await shot());
			return 0;
		case "key":
			await c.act({ type: "key", combo: args.join(" "), shot: { width: 320, format: "jpeg" } });
			console.log(await shot());
			return 0;
		case "scroll":
			await c.act({ type: "scroll", dy: Number(args[0]), x: args[1] ? Number(args[1]) : undefined, y: args[2] ? Number(args[2]) : undefined, shot: { width: 320, format: "jpeg" } });
			console.log(await shot());
			return 0;
		case "navigate":
			print(await c.navigate(args[0]!, 60_000));
			console.log(await shot());
			return 0;
		case "console":
			print(await c.consoleMessages());
			return 0;
		case "network":
			print(await c.networkEvents());
			return 0;
		case "logs":
			console.log(await c.logs(args[0] ?? "app.log", Number(args[1] ?? 100)));
			return 0;
		default:
			console.error(HELP);
			return 3;
	}
}
