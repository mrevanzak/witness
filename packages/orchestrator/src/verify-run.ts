import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputerProvider } from "@acv/computer";
import { bootApp, type BootResult } from "./app-booter.ts";
import { archive, changedFiles, diff, resolveRepo, showFile, type RepoRef } from "./git.ts";
import { RunManager, type Run } from "./run-manager.ts";
import { configSecrets, parseVerifyConfig, type VerifyConfig } from "./verify-config.ts";

export interface VerifyOptions {
	repo: string;
	ref: string;
	base?: string;
	task: string;
	runsDir?: string;
	keep?: boolean;
	enableVnc?: boolean;
	/** Skip plan/execute/verdict: boot, take a screenshot, tear down. */
	bootOnly?: boolean;
	/** Extra context for the planner (e.g. PR title/body). */
	context?: string;
}

export interface VerifyOutcome {
	runId: string;
	runDir: string;
	overall: "pass" | "fail" | "blocked";
	boot: BootResult | { status: "blocked"; reason: string; detail: string };
	verdictPath?: string;
}

export interface Change {
	repo: RepoRef;
	task: string;
	diff: string;
	files: Array<{ status: string; path: string }>;
	readme: string | null;
	verifyYaml: string;
	context?: string;
}

/**
 * The verification pipeline: resolve the change, start a fresh computer, boot the
 * app, then (Phase 3) plan -> execute -> verdict, and always tear down.
 */
export async function verify(provider: ComputerProvider, opts: VerifyOptions, agent?: (ctx: AgentContext) => Promise<string>): Promise<VerifyOutcome> {
	const manager = new RunManager(provider, opts.runsDir);
	const run = manager.create();
	const repo = await resolveRepo(opts.repo, opts.ref, opts.base);
	run.log("run.start", { repo: repo.root, prefix: repo.prefix, sha: repo.sha, base: repo.baseSha, task: opts.task.slice(0, 200) });

	const verifyYaml = await showFile(repo, "verify.yaml");
	const blockedEarly = (reason: string, detail: string): VerifyOutcome => {
		run.log("run.blocked", { reason, detail });
		run.writeJson("verdict.json", { overall: "blocked", reason, detail, criteria: [], console_errors: [], notes: detail });
		return { runId: run.id, runDir: run.dir, overall: "blocked", boot: { status: "blocked", reason, detail } };
	};
	if (!verifyYaml) return blockedEarly("no_verify_yaml", `no verify.yaml at ${repo.prefix || "the repo root"} in ${repo.sha.slice(0, 7)}`);
	let cfg: VerifyConfig;
	try {
		cfg = parseVerifyConfig(verifyYaml);
	} catch (e) {
		return blockedEarly("invalid_verify_yaml", (e as Error).message);
	}
	run.secrets.push(...configSecrets(cfg));

	const change: Change = {
		repo,
		task: opts.task,
		diff: await diff(repo),
		files: await changedFiles(repo),
		readme: (await showFile(repo, "README.md")) ?? (await showFile(repo, "readme.md")),
		verifyYaml,
		context: opts.context,
	};
	writeFileSync(join(run.dir, "change.diff"), change.diff);
	run.writeJson("run.json", { id: run.id, repo: repo.root, prefix: repo.prefix, ref: opts.ref, sha: repo.sha, base: repo.baseSha, task: opts.task, startedAt: new Date().toISOString() });

	const source = await archive(repo);
	return manager.withComputer(run, { keep: opts.keep, enableVnc: opts.enableVnc }, async (computer) => {
		const boot = await bootApp(computer, cfg, source, run);
		if (boot.status === "blocked") {
			run.writeJson("verdict.json", {
				overall: "blocked",
				reason: boot.reason,
				criteria: [],
				console_errors: [],
				notes: `${boot.stage}: ${boot.detail}`,
				log_tail: boot.logTail,
			});
			return { runId: run.id, runDir: run.dir, overall: "blocked", boot };
		}
		if (opts.bootOnly || !agent) {
			await computer.act({ type: "wait", ms: 1500 });
			writeFileSync(join(run.dir, "booted.png"), (await computer.screenshot()).png);
			run.log("run.boot_only", { screenshot: "booted.png" });
			return { runId: run.id, runDir: run.dir, overall: "blocked", boot };
		}
		const verdictPath = await agent({ run, computer, cfg, change });
		const verdict = JSON.parse(readFileSync(verdictPath, "utf8")) as { overall: VerifyOutcome["overall"] };
		return { runId: run.id, runDir: run.dir, overall: verdict.overall, boot, verdictPath };
	});
}

export interface AgentContext {
	run: Run;
	computer: import("@acv/computer").Computer;
	cfg: VerifyConfig;
	change: Change;
}
