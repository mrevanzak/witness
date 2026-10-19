// verify run --repo . --ref HEAD --task "..."
// verify cleanup
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DockerComputerProvider } from "@acv/computer";
import { EXIT_CODES, verifierAgent, verify } from "@acv/orchestrator";

const USAGE = `Usage:
  verify run --repo <dir> [--ref HEAD] [--base <ref>] (--task "<text>" | --task-file <path>)
             [--boot-only] [--keep] [--vnc] [--runs-dir ./runs]
  verify cleanup            remove computers/networks left by crashed runs

Exit codes: 0 pass, 1 fail, 2 blocked, 3 error.`;

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	const provider = new DockerComputerProvider();

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
		},
	});
	const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
	if (!task) {
		console.error("--task or --task-file is required\n\n" + USAGE);
		return 3;
	}

	const bootOnly = values["boot-only"] || task.trim() === "noop";
	if (!bootOnly && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
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
	}, bootOnly ? undefined : verifierAgent());

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
