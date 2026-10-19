// verify run --repo . --ref HEAD --task "..."
// verify cleanup
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DockerComputerProvider } from "@acv/computer";
import { verify } from "@acv/orchestrator";

const USAGE = `Usage:
  verify run --repo <dir> [--ref HEAD] [--base <ref>] (--task "<text>" | --task-file <path>)
             [--boot-only] [--keep] [--vnc] [--runs-dir ./runs]
  verify cleanup            remove computers/networks left by crashed runs

Exit codes: 0 pass, 1 fail, 2 blocked, 3 error.`;

const EXIT = { pass: 0, fail: 1, blocked: 2 } as const;

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

	await provider.cleanupOrphans().catch(() => 0);
	const bootOnly = values["boot-only"] || task.trim() === "noop";
	const outcome = await verify(provider, {
		repo: values.repo,
		ref: values.ref,
		base: values.base,
		task,
		bootOnly,
		keep: values.keep,
		enableVnc: values.vnc,
		runsDir: values["runs-dir"],
	});

	if (outcome.boot.status === "blocked") {
		console.log(`BLOCKED (${outcome.boot.reason}): ${outcome.boot.detail}`);
		if ("logTail" in outcome.boot && outcome.boot.logTail) console.log(`--- log tail ---\n${outcome.boot.logTail}`);
	} else if (bootOnly) {
		console.log(`BOOTED ${outcome.boot.url} in ${(outcome.boot.ms / 1000).toFixed(1)} s (boot only, no verdict)`);
	} else {
		console.log(`${outcome.overall.toUpperCase()} - ${outcome.verdictPath}`);
	}
	console.log(`run dir: ${outcome.runDir}`);
	return bootOnly && outcome.boot.status === "ok" ? 0 : EXIT[outcome.overall];
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(e) => {
		console.error(e instanceof Error ? (e.stack ?? e.message) : e);
		process.exit(3);
	}
);
