import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Computer, ComputerProvider } from "@acv/computer";
import { redact, redactDeep } from "./redact.ts";

export interface Run {
	id: string;
	/** Orchestrator-owned outputs: plan.json, steps.jsonl, verdict.json, report.html, ... */
	dir: string;
	/** Bind-mounted at /artifacts in the computer. Written by the computer (untrusted). */
	computerDir: string;
	secrets: string[];
	log(event: string, data?: Record<string, unknown>): void;
	writeJson(name: string, value: unknown): string;
}

export function newRunId(now = new Date()): string {
	const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	return `${ts}-${randomBytes(3).toString("hex")}`;
}

/**
 * One run = one run directory + one fresh computer (+ sibling services) on its own
 * network, destroyed at the end whatever happens.
 */
export class RunManager {
	constructor(
		private readonly provider: ComputerProvider,
		private readonly runsDir = resolve("runs"),
		private readonly quiet = false
	) {}

	create(id = newRunId()): Run {
		const dir = join(this.runsDir, id);
		const computerDir = join(dir, "computer");
		mkdirSync(computerDir, { recursive: true });
		const run: Run = {
			id,
			dir,
			computerDir,
			secrets: [],
			log: (event, data = {}) => {
				const line = redactDeep({ at: new Date().toISOString(), event, ...data }, run.secrets);
				appendFileSync(join(dir, "run.log.jsonl"), `${JSON.stringify(line)}\n`);
				if (!this.quiet) {
					const extra = Object.keys(data).length ? ` ${redact(JSON.stringify(data), run.secrets).slice(0, 300)}` : "";
					console.error(`[${id}] ${event}${extra}`);
				}
			},
			writeJson: (name, value) => {
				const p = join(dir, name);
				writeFileSync(p, `${JSON.stringify(redactDeep(value, run.secrets), null, 2)}\n`);
				return p;
			},
		};
		return run;
	}

	/** Creates the computer, runs `fn`, and always tears everything down (unless `keep`). */
	async withComputer<T>(run: Run, opts: { enableVnc?: boolean; keep?: boolean }, fn: (c: Computer) => Promise<T>): Promise<T> {
		const t = Date.now();
		const computer = await this.provider.create({ runId: run.id, artifactsDir: run.computerDir, enableVnc: opts.enableVnc });
		run.log("computer.created", { id: computer.id.slice(0, 12), network: computer.network, ms: Date.now() - t, liveView: computer.liveViewUrl });
		if (computer.control) {
			const p = join(run.dir, "session.json");
			writeFileSync(p, JSON.stringify({ id: computer.id, ...computer.control, liveView: computer.liveViewUrl }, null, 2));
			chmodSync(p, 0o600);
		}
		const onSignal = () => {
			run.log("interrupted");
			void computer.destroy().finally(() => process.exit(130));
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		try {
			return await fn(computer);
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			if (opts.keep) {
				run.log("computer.kept", { id: computer.id.slice(0, 12), hint: `docker rm -f $(docker ps -aq --filter label=acv.run=${run.id})` });
			} else {
				const s = Date.now();
				await computer.destroy();
				run.log("computer.destroyed", { ms: Date.now() - s });
			}
		}
	}
}
