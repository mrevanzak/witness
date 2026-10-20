import { createHash } from "node:crypto"

/**
 * Flags when the agent repeats the same action and the screen does not change.
 * `observe` returns true once `threshold` identical (action, screen) pairs occur in a row.
 */
export class StuckDetector {
	private lastKey = ""
	private count = 0

	constructor(private readonly threshold = 3) {}

	static hash(data: Buffer | string): string {
		return createHash("sha1").update(data).digest("hex")
	}

	observe(action: string, screenHash: string): boolean {
		const key = `${action}|${screenHash}`
		if (key === this.lastKey) {
			this.count += 1
		} else {
			this.lastKey = key
			this.count = 1
		}
		return this.count >= this.threshold
	}

	reset(): void {
		this.lastKey = ""
		this.count = 0
	}
}

/** Canonical action signature: tool + its arguments, minus the free-text label. */
export function actionSignature(tool: string, input: unknown): string {
	const { label: _label, ...rest } = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
	return `${tool}:${JSON.stringify(rest, Object.keys(rest).sort())}`
}
