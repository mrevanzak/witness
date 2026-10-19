// The verifier agent: plan (no computer) -> record + execute -> stop recording ->
// review -> verdict.json. Returns the verdict path.
import { join } from "node:path";
import { execute, type ExecuteOptions } from "./execute.ts";
import { ClaudeModel, type Model } from "./model.ts";
import { makePlan } from "./plan.ts";
import { buildVerdict, review } from "./verdict.ts";
import type { AgentContext } from "./verify-run.ts";

export function verifierAgent(opts: { model?: Model; execute?: ExecuteOptions } = {}) {
	return async ({ run, computer, cfg, change }: AgentContext): Promise<string> => {
		const model = opts.model ?? new ClaudeModel();
		run.log("plan.start", { model: model.id });
		const plan = await makePlan(model, change, cfg, run.secrets);
		run.writeJson("plan.json", plan);
		run.log("plan.done", { criteria: plan.criteria.map((c) => `${c.id} ${c.kind}: ${c.description}`), usd: Number(model.usage.usd.toFixed(3)) });

		// Drop console noise from boot so it is not blamed on the first criterion.
		await computer.consoleMessages().catch(() => []);
		await computer.networkEvents().catch(() => []);
		await computer.startRecording("raw.mkv");
		await computer.act({ type: "wait", ms: 700 });
		let exec;
		try {
			exec = await execute({ model, computer, run, plan, cfg, options: opts.execute });
		} finally {
			await computer.act({ type: "wait", ms: 800 }).catch(() => undefined);
		}
		const rec = await computer.stopRecording();
		const steps = exec.steps.finalize(rec.t0);
		run.log("execute.done", { stopped: exec.stoppedBecause, steps: steps.length, video_s: rec.duration, usd: Number(model.usage.usd.toFixed(3)) });

		const appLogTail = await computer.logs("app.log", 120).catch(() => "");
		const reviewed = await review({ model, plan, exec, steps, appLogTail, secrets: run.secrets });
		const verdict = buildVerdict({ plan, exec, reviewed, t0: rec.t0, duration: rec.duration, model });
		const path = run.writeJson("verdict.json", verdict);
		run.writeJson("usage.json", { model: model.id, ...model.usage });
		run.log("verdict", { overall: verdict.overall, criteria: verdict.criteria.map((c) => `${c.id}=${c.status}`), usd: verdict.usage.usd });
		return path;
	};
}

export const VIDEO_FILE = (runDir: string) => join(runDir, "computer", "raw.mp4");
