// Module resolution hook for walkthrough files: `effect`, `effect/*` and
// `@witness/*` resolve from the CLI itself, so a walkthrough works from any
// folder and shares Witness's copy of Effect.
let parentURL

export function initialize(data) {
	parentURL = data.parentURL
}

export async function resolve(specifier, context, next) {
	if (specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@witness/")) {
		return next(specifier, { ...context, parentURL })
	}
	return next(specifier, context)
}
