import type { Computer } from "@witness/computer";
import { chownTar } from "./tar.ts";
import type { Run } from "./run-manager.ts";
import type { VerifyConfig } from "./verify-config.ts";

export const APP_DIR = "/home/qa/app";
const QA = { uid: 1000, gid: 1000, user: "qa", group: "qa" };

export type BootResult =
	| { status: "ok"; url: string; ms: number }
	| { status: "blocked"; reason: "app_failed_to_boot"; stage: "upload" | "services" | "setup" | "start" | "health"; detail: string; logTail: string };

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Copies the repo snapshot into the computer, starts sibling services, runs
 * `setup`, starts the app (stdout/stderr -> /artifacts/app.log), waits for the
 * health URL, and opens the app in Chromium. A boot failure is a `blocked`
 * result with the log tail, not an exception.
 */
export async function bootApp(computer: Computer, cfg: VerifyConfig, source: Buffer, run: Run, staged: Buffer | null = null): Promise<BootResult> {
	const started = Date.now();
	const blocked = async (stage: Extract<BootResult, { status: "blocked" }>["stage"], detail: string, logFile?: string): Promise<BootResult> => {
		const logTail = logFile ? await computer.logs(logFile, 60).catch(() => "") : "";
		run.log("boot.blocked", { stage, detail });
		return { status: "blocked", reason: "app_failed_to_boot", stage, detail, logTail };
	};

	await computer.putArchive(chownTar(source, QA), APP_DIR);
	if (staged) await computer.putArchive(staged, APP_DIR);
	const check = await computer.exec({ cmd: `test -w ${APP_DIR} && ls -A ${APP_DIR} | head -50` });
	if (check.code !== 0) return blocked("upload", `source not writable in ${APP_DIR}: ${check.stderr}`);
	run.log("boot.source", { files: check.stdout.split("\n").filter(Boolean).length });

	for (const [name, svc] of Object.entries(cfg.services)) {
		try {
			await computer.startService(name, svc);
		} catch (e) {
			return blocked("services", `service ${name} (${svc.image}) failed to start: ${(e as Error).message}`);
		}
		if (svc.port) {
			const wait = await computer.exec({
				cmd: `for i in $(seq 1 120); do (echo > /dev/tcp/${name}/${svc.port}) 2>/dev/null && exit 0; sleep 0.5; done; exit 1`,
				timeoutMs: 70_000,
			});
			if (wait.code !== 0) return blocked("services", `service ${name} never accepted connections on ${svc.port}`);
		}
		run.log("boot.service", { name, image: svc.image, port: svc.port });
	}

	const deadline = Date.now() + cfg.timeouts.setupSec * 1000;
	for (const cmd of cfg.setup) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return blocked("setup", `setup exceeded ${cfg.timeouts.setupSec}s`, "setup.log");
		const t = Date.now();
		const res = await computer.exec({
			cmd: `echo "\\$ "${sh(cmd)} >> /artifacts/setup.log; { ${cmd} ; } >> /artifacts/setup.log 2>&1`,
			cwd: APP_DIR,
			env: cfg.env,
			timeoutMs: remaining,
		});
		if (res.timed_out) return blocked("setup", `setup command timed out: ${cmd}`, "setup.log");
		if (res.code !== 0) return blocked("setup", `setup command exited ${res.code}: ${cmd}`, "setup.log");
		run.log("boot.setup", { cmd, ms: Date.now() - t });
	}

	const start = await computer.exec({ cmd: `exec ${cfg.start}`, cwd: APP_DIR, env: cfg.env, background: true, log: "app.log" });
	run.log("boot.start", { cmd: cfg.start, pid: start.pid });

	const bootDeadline = Date.now() + cfg.timeouts.bootSec * 1000;
	let lastCode = "";
	while (Date.now() < bootDeadline) {
		const res = await computer.exec({ cmd: `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ${sh(cfg.health)}`, timeoutMs: 10_000 });
		lastCode = res.stdout.trim() || res.stderr.trim();
		const code = Number(res.stdout.trim());
		if (code >= 200 && code < 400) break;
		const alive = await computer.exec({ cmd: `kill -0 ${start.pid}` });
		if (alive.code !== 0) return blocked("start", `start command exited before ${cfg.health} responded`, "app.log");
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (Date.now() >= bootDeadline) return blocked("health", `${cfg.health} not healthy after ${cfg.timeouts.bootSec}s (last: ${lastCode})`, "app.log");

	const nav = await computer.navigate(cfg.url, { timeoutMs: 60_000 });
	if (nav.error) return blocked("health", `Chromium could not open ${cfg.url}: ${nav.error}`, "app.log");
	run.log("boot.ok", { url: nav.url, status: nav.status, ms: Date.now() - started });
	return { status: "ok", url: cfg.url, ms: Date.now() - started };
}
