// Thin model seam: the verifier only needs "send a Messages request" and "send one
// and parse structured JSON". ClaudeModel is the Anthropic implementation; tests or
// other providers can implement Model directly.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelRequest = Omit<CreateParams, "model" | "betas" | "fallbacks">;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage;

export interface Usage {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	usd: number;
}

export interface Model {
	readonly id: string;
	readonly usage: Usage;
	create(req: ModelRequest): Promise<ModelMessage>;
	parse<T>(req: ModelRequest, schema: z.ZodType<T>): Promise<{ parsed: T | null; message: ModelMessage }>;
}

/** $ per million tokens: [input, output, cache read]. Cache writes are 1.25x input. */
const PRICES: Record<string, [number, number, number]> = {
	"claude-opus-5-5": [4, 20, 0.2],
	"claude-sonnet-5-5": [2, 10, 0.2],
	"claude-haiku-5-5": [0.1, 0.5, 0.01],
	"claude-fable-5-1": [10, 50, 0.25],
};

export function estimateUsd(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
	const [inp, out, read] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
	const m = 1e6;
	return ((u.input_tokens ?? 0) * inp + (u.cache_creation_input_tokens ?? 0) * inp * 1.25 + (u.cache_read_input_tokens ?? 0) * read + (u.output_tokens ?? 0) * out) / m;
}

export class BudgetExceeded extends Error {}

export interface ClaudeModelOptions {
	model?: string;
	client?: Anthropic;
	/** Refuse new requests once the estimated spend reaches this. */
	maxUsd?: number;
	/** Server-side refusal fallback (on by default). */
	fallbacks?: boolean;
	/** Extra beta flags for every request. */
	betas?: string[];
}

export class ClaudeModel implements Model {
	readonly id: string;
	readonly usage: Usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
	private readonly client: Anthropic;
	private readonly maxUsd: number;
	private readonly fallbacks: boolean;
	private readonly betas: string[];

	constructor(opts: ClaudeModelOptions = {}) {
		this.id = opts.model ?? process.env.ACV_MODEL ?? "claude-opus-5-5";
		this.client = opts.client ?? new Anthropic({ maxRetries: 4 });
		this.maxUsd = opts.maxUsd ?? Number(process.env.ACV_MAX_USD ?? 5);
		this.fallbacks = opts.fallbacks ?? process.env.ACV_FALLBACKS !== "0";
		this.betas = opts.betas ?? [];
	}

	private params(req: ModelRequest): CreateParams {
		const betas = [...this.betas];
		const extra: Partial<CreateParams> = {};
		if (this.fallbacks) {
			betas.push("server-side-fallback-2026-07-01");
			extra.fallbacks = "default";
		}
		if (req.context_management) betas.push("context-management-2025-06-27");
		return { model: this.id, ...req, ...extra, betas: [...new Set(betas)] };
	}

	private track(m: ModelMessage): void {
		const u = m.usage;
		this.usage.requests++;
		this.usage.input += u.input_tokens ?? 0;
		this.usage.output += u.output_tokens ?? 0;
		this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
		this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
		this.usage.usd += estimateUsd(m.model ?? this.id, u);
	}

	private checkBudget(): void {
		if (this.usage.usd >= this.maxUsd) throw new BudgetExceeded(`model budget of $${this.maxUsd.toFixed(2)} reached ($${this.usage.usd.toFixed(2)} spent)`);
	}

	async create(req: ModelRequest): Promise<ModelMessage> {
		this.checkBudget();
		const m = await this.client.beta.messages.create(this.params(req));
		this.track(m);
		return m;
	}

	async parse<T>(req: ModelRequest, schema: z.ZodType<T>): Promise<{ parsed: T | null; message: ModelMessage }> {
		this.checkBudget();
		const params = { ...this.params(req), output_config: { ...req.output_config, format: betaZodOutputFormat(schema) } };
		const m = await this.client.beta.messages.parse(params);
		this.track(m);
		return { parsed: (m.parsed_output as T | null | undefined) ?? null, message: m };
	}
}

export function textOf(m: ModelMessage): string {
	return m.content
		.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
