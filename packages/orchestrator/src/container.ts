// Where the app lives inside the computer, who owns it, and how commands quote.
import { makeTar } from "./tar.ts"

/** The app's source, extracted from `git archive`, owned by the computer's non-root user. */
export const APP_DIR = "/home/qa/app"
export const QA_OWNER = { gid: 1000, group: "qa", uid: 1000, user: "qa" } as const

/** Single-quotes `s` for `sh -c`. */
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** A tar of `files`, owned by the qa user, ready for `putArchive`. */
export const qaTar = (files: Parameters<typeof makeTar>[0]) => makeTar(files, QA_OWNER)
