/** The message of a thrown value, for wrapping foreign failures in typed errors. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
