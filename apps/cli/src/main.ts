// witness run --repo . --ref HEAD --task "..."
// witness cleanup
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DockerComputerProvider } from "@witness/computer";
import { renderRun } from "@witness/renderer";
import { drive } from "./drive.ts";
import { publish } from "./publish.ts";
import { EXIT_CODES, writeComparisonReport, writeReport, verifierAgent, verify, walkthroughAgent, type Walkthrough } from "@witness/orchestrator";

const USAGE = `Usage:
  witness run --repo <dir> [--ref HEAD] [--base <ref>] (--task "<text>" | --task-file <path>)
             [--config witness.yaml] [--walkthrough script.ts] [--memory-gb 4] [--cpus 2]
             [--boot-only] [--keep] [--vnc] [--runs-dir ./runs]

  --config       witness.yaml outside the repo (for repos without one); may stage host files and secret env
  --walkthrough  in-session mode: a script (default export (ctx) => ...) drives the app instead of the model
  witness render <runDir> [--label after]   polished.mp4 + preview.gif from a finished run
  witness report <runDir>    report.md ("## Manual verification") from a finished run
  witness report --compare <beforeRun> <afterRun> --out <dir>   before/after report bundle
  witness drive <runDir> …   hand-drive a kept computer (see \`witness drive\`)
  witness publish --pr N --report <report.md> [--mode auto|description|comment] [--ego-space id] [--dry-run]
  witness cleanup            remove computers/networks left by crashed runs

Exit codes: 0 pass, 1 fail, 2 blocked, 3 error.`;

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	let provider = new DockerComputerProvider();

	if (cmd === "drive") return drive(rest);
	if (cmd === "publish") return publish(rest);
	if (cmd === "render") {
		const label = rest.includes("--label") ? rest[rest.indexOf("--label") + 1] : undefined;
		const r = await renderRun(rest[0]!, { label, onProgress: (l) => process.stderr.write(`\r${l.slice(0, 80).padEnd(80)}`) });
		console.error("");
		console.log(`${r.polished} (${r.durationSec.toFixed(1)} s)\n${r.gif}`);
		return 0;
	}
	if (cmd === "report") {
		if (rest[0] === "--compare") {
			const { values } = parseArgs({ args: rest.slice(3), options: { out: { type: "string" }, preview: { type: "string" }, intro: { type: "string" } } });
			if (!rest[1] || !rest[2] || !values.out) {
				console.error("usage: witness report --compare <beforeRunDir> <afterRunDir> --out <dir> [--preview text] [--intro text]");
				return 3;
			}
			console.log(writeComparisonReport({ before: rest[1], after: rest[2], outDir: values.out, preview: values.preview, intro: values.intro }));
			return 0;
		}
		console.log(writeReport(rest[0]!));
		return 0;
	}
	if (cmd === "cleanup") {
		const n = await provider.cleanupOrphans();
		console.log(`removed ${n} orphaned run(s)`);
		return 0;
	}
	if (cmd !== "run") {
		console.error(USAGE);
		return cmd ? 3 : 0;
	}

	const { values } = parseArgs({
		args: rest,
		options: {
			repo: { type: "string", default: "." },
			ref: { type: "string", default: "HEAD" },
			base: { type: "string" },
			task: { type: "string" },
			"task-file": { type: "string" },
			"boot-only": { type: "boolean", default: false },
			keep: { type: "boolean", default: false },
			vnc: { type: "boolean", default: false },
			"runs-dir": { type: "string" },
			config: { type: "string" },
			walkthrough: { type: "string" },
			"memory-gb": { type: "string" },
			cpus: { type: "string" },
		},
	});
	if (values["memory-gb"] || values.cpus) {
		provider = new DockerComputerProvider({ memoryBytes: Number(values["memory-gb"] ?? 4) * 1024 ** 3, cpus: Number(values.cpus ?? 2) });
	}
	let walk: Walkthrough | undefined;
	if (values.walkthrough) {
		const mod = (await import(pathToFileURL(resolve(values.walkthrough)).href)) as { default?: Walkthrough };
		if (typeof mod.default !== "function") {
			console.error(`${values.walkthrough} must default-export an async function (ctx) => ...`);
			return 3;
		}
		walk = mod.default;
	}
	const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
	if (!task) {
		console.error("--task or --task-file is required\n\n" + USAGE);
		return 3;
	}

	const bootOnly = values["boot-only"] || task.trim() === "noop";
	if (!bootOnly && !walk && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
		console.error("ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is required for a verification run; use --boot-only to just boot the app.");
		return 3;
	}
	await provider.cleanupOrphans().catch(() => 0);
	const outcome = await verify(provider, {
		repo: values.repo,
		ref: values.ref,
		base: values.base,
		task,
		bootOnly,
		keep: values.keep,
		enableVnc: values.vnc,
		runsDir: values["runs-dir"],
		configPath: values.config,
	}, bootOnly ? undefined : walk ? walkthroughAgent(walk) : verifierAgent());

	if (outcome.boot.status === "blocked") {
		console.log(`BLOCKED (${outcome.boot.reason}): ${outcome.boot.detail}`);
		if ("logTail" in outcome.boot && outcome.boot.logTail) console.log(`--- log tail ---\n${outcome.boot.logTail}`);
	} else if (bootOnly) {
		console.log(`BOOTED ${outcome.boot.url} in ${(outcome.boot.ms / 1000).toFixed(1)} s (boot only, no verdict)`);
	} else {
		const v = JSON.parse(readFileSync(outcome.verdictPath!, "utf8")) as { criteria: Array<{ id: string; status: string; description: string; video_ts: [number, number] | null }>; usage: { usd: number } };
		console.log(`\n${outcome.overall.toUpperCase()}`);
		for (const c of v.criteria) console.log(`  ${c.id} ${c.status.padEnd(7)} ${c.description}${c.video_ts ? `  [${c.video_ts[0]}s-${c.video_ts[1]}s]` : ""}`);
		console.log(`  model spend ≈ $${v.usage.usd.toFixed(2)}`);
	}
	console.log(`run dir: ${outcome.runDir}`);
	return bootOnly && outcome.boot.status === "ok" ? 0 : EXIT_CODES[outcome.overall];
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(e) => {
		console.error(e instanceof Error ? (e.stack ?? e.message) : e);
		process.exit(3);
	}
);
