// Rewrites ownership in a ustar/pax archive (e.g. `git archive` output, which is
// all uid 0) so files extracted into the computer belong to the non-root `qa` user.

const BLOCK = 512

function readOctal(buf: Buffer, off: number, len: number): number {
	// GNU base-256 for large values: high bit of the first byte set.
	if (buf[off]! & 0x80) {
		let n = buf[off]! & 0x7f
		for (let i = 1; i < len; i++) {
			n = n * 256 + buf[off + i]!
		}
		return n
	}
	const s = buf
		.toString("ascii", off, off + len)
		.replace(/\0.*$/s, "")
		.trim()
	return s ? Number.parseInt(s, 8) : 0
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
	const s = value.toString(8).padStart(len - 1, "0")
	buf.write(`${s}\0`, off, len, "ascii")
}

function writeString(buf: Buffer, off: number, len: number, value: string): void {
	buf.fill(0, off, off + len)
	buf.write(value.slice(0, len - 1), off, len, "utf8")
}

function isZeroBlock(buf: Buffer, off: number): boolean {
	for (let i = off; i < off + BLOCK; i++) {
		if (buf[i] !== 0) {
			return false
		}
	}
	return true
}

export function checksum(header: Buffer): number {
	let sum = 0
	for (let i = 0; i < BLOCK; i++) {
		sum += i >= 148 && i < 156 ? 0x20 : header[i]!
	}
	return sum
}

export function chownTar(tar: Uint8Array, owner: { uid: number; gid: number; user: string; group: string }): Buffer {
	const out = Buffer.from(tar)
	let off = 0
	while (off + BLOCK <= out.length) {
		if (isZeroBlock(out, off)) {
			break
		}
		const header = out.subarray(off, off + BLOCK)
		const stored = readOctal(header, 148, 8)
		if (stored !== checksum(header)) {
			throw new Error(`tar: bad header checksum at offset ${off}`)
		}
		const size = readOctal(header, 124, 12)
		writeOctal(header, 108, 8, owner.uid)
		writeOctal(header, 116, 8, owner.gid)
		if (header.toString("ascii", 257, 262) === "ustar") {
			writeString(header, 265, 32, owner.user)
			writeString(header, 297, 32, owner.group)
		}
		const sum = checksum(header)
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
		off += BLOCK + Math.ceil(size / BLOCK) * BLOCK
	}
	return out
}

/** Lists entry names (for tests and debugging). */
export function tarEntries(tar: Buffer): Array<{ name: string; uid: number; gid: number; type: string }> {
	const entries: Array<{ name: string; uid: number; gid: number; type: string }> = []
	let off = 0
	while (off + BLOCK <= tar.length && !isZeroBlock(tar, off)) {
		const h = tar.subarray(off, off + BLOCK)
		const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "")
		const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "")
		entries.push({
			gid: readOctal(h, 116, 8),
			name: prefix ? `${prefix}/${name}` : name,
			type: String.fromCharCode(h[156] || 48),
			uid: readOctal(h, 108, 8),
		})
		off += BLOCK + Math.ceil(readOctal(h, 124, 12) / BLOCK) * BLOCK
	}
	return entries
}

/** Builds a ustar archive (parent directories included) owned by `owner`. Names use "/" and are relative. */
export function makeTar(
	files: Array<{ name: string; data: Buffer; mode?: number }>,
	owner: { uid: number; gid: number; user: string; group: string },
	mtime = Math.floor(Date.now() / 1000)
): Buffer {
	const blocks: Buffer[] = []
	const seen = new Set<string>()
	const header = (name: string, size: number, mode: number, type: "0" | "5") => {
		const h = Buffer.alloc(BLOCK)
		let prefix = ""
		let base = name
		if (Buffer.byteLength(name) > 99) {
			const cut = name.lastIndexOf("/", 154)
			if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 99) {
				throw new Error(`tar: name too long: ${name}`)
			}
			prefix = name.slice(0, cut)
			base = name.slice(cut + 1)
		}
		writeString(h, 0, 100, base)
		writeOctal(h, 100, 8, mode)
		writeOctal(h, 108, 8, owner.uid)
		writeOctal(h, 116, 8, owner.gid)
		writeOctal(h, 124, 12, size)
		writeOctal(h, 136, 12, mtime)
		h.write(type, 156, 1, "ascii")
		h.write("ustar\0", 257, 6, "ascii")
		h.write("00", 263, 2, "ascii")
		writeString(h, 265, 32, owner.user)
		writeString(h, 297, 32, owner.group)
		writeString(h, 345, 155, prefix)
		h.write(`${checksum(h).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
		return h
	}
	for (const f of files) {
		const name = f.name.replace(/^\.?\/+/, "")
		if (!name || name.split("/").includes("..")) {
			throw new Error(`tar: bad name ${f.name}`)
		}
		const parts = name.split("/")
		for (let i = 1; i < parts.length; i++) {
			const dir = `${parts.slice(0, i).join("/")}/`
			if (!seen.has(dir)) {
				seen.add(dir)
				blocks.push(header(dir, 0, 0o755, "5"))
			}
		}
		blocks.push(
			header(name, f.data.length, f.mode ?? 0o644, "0"),
			f.data,
			Buffer.alloc((BLOCK - (f.data.length % BLOCK)) % BLOCK)
		)
	}
	blocks.push(Buffer.alloc(BLOCK * 2))
	return Buffer.concat(blocks)
}
