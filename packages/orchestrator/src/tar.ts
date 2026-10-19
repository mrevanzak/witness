// Rewrites ownership in a ustar/pax archive (e.g. `git archive` output, which is
// all uid 0) so files extracted into the computer belong to the non-root `qa` user.

const BLOCK = 512;

function readOctal(buf: Buffer, off: number, len: number): number {
	// GNU base-256 for large values: high bit of the first byte set.
	if (buf[off]! & 0x80) {
		let n = buf[off]! & 0x7f;
		for (let i = 1; i < len; i++) n = n * 256 + buf[off + i]!;
		return n;
	}
	const s = buf.toString("ascii", off, off + len).replace(/\0.*$/s, "").trim();
	return s ? Number.parseInt(s, 8) : 0;
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
	const s = value.toString(8).padStart(len - 1, "0");
	buf.write(`${s}\0`, off, len, "ascii");
}

function writeString(buf: Buffer, off: number, len: number, value: string): void {
	buf.fill(0, off, off + len);
	buf.write(value.slice(0, len - 1), off, len, "utf8");
}

function isZeroBlock(buf: Buffer, off: number): boolean {
	for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
	return true;
}

export function checksum(header: Buffer): number {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
	return sum;
}

export function chownTar(tar: Buffer, owner: { uid: number; gid: number; user: string; group: string }): Buffer {
	const out = Buffer.from(tar);
	let off = 0;
	while (off + BLOCK <= out.length) {
		if (isZeroBlock(out, off)) break;
		const header = out.subarray(off, off + BLOCK);
		const stored = readOctal(header, 148, 8);
		if (stored !== checksum(header)) throw new Error(`tar: bad header checksum at offset ${off}`);
		const size = readOctal(header, 124, 12);
		writeOctal(header, 108, 8, owner.uid);
		writeOctal(header, 116, 8, owner.gid);
		if (header.toString("ascii", 257, 262) === "ustar") {
			writeString(header, 265, 32, owner.user);
			writeString(header, 297, 32, owner.group);
		}
		const sum = checksum(header);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
	}
	return out;
}

/** Lists entry names (for tests and debugging). */
export function tarEntries(tar: Buffer): Array<{ name: string; uid: number; gid: number; type: string }> {
	const entries: Array<{ name: string; uid: number; gid: number; type: string }> = [];
	let off = 0;
	while (off + BLOCK <= tar.length && !isZeroBlock(tar, off)) {
		const h = tar.subarray(off, off + BLOCK);
		const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
		const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
		entries.push({ name: prefix ? `${prefix}/${name}` : name, uid: readOctal(h, 108, 8), gid: readOctal(h, 116, 8), type: String.fromCharCode(h[156] || 48) });
		off += BLOCK + Math.ceil(readOctal(h, 124, 12) / BLOCK) * BLOCK;
	}
	return entries;
}
