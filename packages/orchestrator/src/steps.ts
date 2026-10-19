// The step log: one line per verifier tool call. `at` is wall-clock ms on the
// computer's clock; `t` (seconds into raw.mp4) is filled in once the recording
// stops and its first-frame time t0 is known.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { redactDeep } from "./redact.ts";

export interface Step {
	/** Seconds since the first video frame. */
	t?: number;
	/** Wall-clock ms (computer clock). */
	at: number;
	tool: string;
	/** Short human caption, shown in the polished video. Never contains secrets. */
	label?: string;
	criterion?: string;
	/** Screen pixels (full resolution) of the action point, for zoom and cursor. */
	x?: number;
	y?: number;
	to_x?: number;
	to_y?: number;
	/** Extra tool-specific facts (status for end_criterion, url for navigate, ...). */
	[key: string]: unknown;
}

export class StepLog {
	readonly steps: Step[] = [];
	constructor(
		private readonly path: string,
		private readonly secrets: readonly string[]
	) {
		writeFileSync(path, "");
	}

	add(step: Step): Step {
		const clean = redactDeep(step, this.secrets);
		this.steps.push(clean);
		appendFileSync(this.path, `${JSON.stringify(clean)}\n`);
		return clean;
	}

	/** Rewrites the log with `t` relative to the first video frame. */
	finalize(t0: number | null): Step[] {
		const base = t0 ?? this.steps[0]?.at ?? 0;
		for (const s of this.steps) s.t = Math.round(((s.at - base) / 1000) * 100) / 100;
		writeFileSync(this.path, this.steps.map((s) => JSON.stringify(s)).join("\n") + (this.steps.length ? "\n" : ""));
		return this.steps;
	}
}

export function parseSteps(text: string): Step[] {
	const steps: Step[] = [];
	for (const [i, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		let s: unknown;
		try {
			s = JSON.parse(line);
		} catch {
			throw new Error(`steps.jsonl line ${i + 1}: invalid JSON`);
		}
		if (!s || typeof s !== "object" || typeof (s as Step).tool !== "string" || typeof (s as Step).at !== "number") {
			throw new Error(`steps.jsonl line ${i + 1}: needs "tool" (string) and "at" (number)`);
		}
		steps.push(s as Step);
	}
	return steps.sort((a, b) => a.at - b.at);
}

export function readSteps(path: string): Step[] {
	return parseSteps(readFileSync(path, "utf8"));
}
