const MASK = "[redacted]"

/** The message of anything thrown or failed with. */
export const messageOf = (e: unknown): string =>
	e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : String(e)

/** A secret shorter than this is not masked: it would match all over ordinary text. */
export const isRedactable = (secret: string): boolean => secret.length >= 3

/** Replaces every occurrence of each secret (and its URL-encoded form) with a mask. Pure. */
export function redact(text: string, secrets: readonly string[]): string {
	let out = text
	for (const s of secrets) {
		if (!s) {
			continue
		}
		for (const form of new Set([s, encodeURIComponent(s)])) {
			out = out.split(form).join(MASK)
		}
	}
	return out
}

/** Deep-redacts string values of a JSON-able value. Pure. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
	if (secrets.length === 0) {
		return value
	}
	if (typeof value === "string") {
		return redact(value, secrets) as T
	}
	if (Array.isArray(value)) {
		return value.map((v) => redactDeep(v, secrets)) as T
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T
	}
	return value
}
