/**
 * stdoutDemux.ts — the backend stdout demuxer.
 *
 * The Python sidecar's stdout interleaves '\n'-terminated text lines
 * (PLOTAPP: JSON and plain log output) with raw PLOTBIN binary frames
 * (PLOTBIN:<hlen>:<plen>\n<header_json><payload>). readline can't carry
 * binary, so the raw Buffer stream is parsed here, accumulating partial
 * reads; the event trace must be invariant to how the OS slices the stream
 * into 'data' chunks (Windows delivers a large child-stdout write as uniform
 * 64 KiB chunks).
 */

export interface DemuxHandlers {
  onMessage: (msg: Record<string, unknown>) => void
  onStream: (text: string, kind: 'stdout' | 'stderr') => void
  onBinary?: (header: Record<string, unknown>, payload: Buffer) => void
}

export interface StdoutDemux {
  /** Feed one stdout 'data' chunk; fires handlers for each completed unit. */
  push(chunk: Buffer): void
}

const PLOTBIN = Buffer.from('PLOTBIN:')
const NL = 0x0a

/**
 * Chunk-list accumulator (perf arc Phase F fix #4). The previous
 * implementation concatenated every incoming chunk onto one accumulator
 * (`Buffer.concat([acc, chunk])`), recopying the whole buffered prefix per
 * chunk — O(N²/chunkSize) while a large PLOTBIN frame streams in: measured
 * 813 ms per 16 MB frame and 11.9 s / 32.9 GB copied per 64 MB frame at the
 * OS's 64 KiB chunk size. This version keeps the chunks in a list and copies
 * each byte exactly once, into the emitted unit (payload/header/line):
 * 6.6 ms per 16 MB frame, 30 ms per 64 MB. Byte-identical event traces
 * proven across chunkings in stdoutDemux.test.ts (and previously in the
 * tools/perf/transport bench, incl. 1-byte splits).
 */
export function createStdoutDemux(handlers: DemuxHandlers): StdoutDemux {
  const chunks: Buffer[] = []   // chunks[0] is valid from `off`
  let off = 0                   // consumed bytes inside chunks[0]
  let total = 0                 // unconsumed bytes across the list
  let noNLBefore = 0            // scan hint: first `noNLBefore` bytes have no NL

  // byte at logical position i (i < total); only used for the tiny marker probe
  const byteAt = (i: number): number => {
    let pos = i + off
    for (const c of chunks) {
      if (pos < c.length) return c[pos]
      pos -= c.length
    }
    return -1
  }

  const startsWithMarker = (): boolean => {
    for (let i = 0; i < PLOTBIN.length; i++) {
      if (byteAt(i) !== PLOTBIN[i]) return false
    }
    return true
  }

  // logical index of the first NL at/after `from`, else -1 (uses + updates the
  // hint so an incomplete unit is never rescanned from the start)
  const findNL = (from: number): number => {
    const start = Math.max(from, noNLBefore)
    let logical = 0             // logical index of the start of chunk ci
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci]
      const cOff = ci === 0 ? off : 0
      const cLen = c.length - cOff
      if (start < logical + cLen) {
        const within = cOff + Math.max(0, start - logical)
        const hit = c.indexOf(NL, within)
        if (hit >= 0) return logical + (hit - cOff)
      }
      logical += cLen
    }
    noNLBefore = total
    return -1
  }

  // copy `len` bytes starting at logical `start` into a fresh Buffer — the
  // single copy each emitted byte pays
  const extract = (start: number, len: number): Buffer => {
    const out = Buffer.allocUnsafe(len)
    if (len === 0) return out
    let pos = start + off
    let ci = 0
    while (pos >= chunks[ci].length) { pos -= chunks[ci].length; ci++ }
    let written = 0
    while (written < len) {
      const c = chunks[ci]
      const n = Math.min(len - written, c.length - pos)
      c.copy(out, written, pos, pos + n)
      written += n; pos = 0; ci++
    }
    return out
  }

  const consume = (n: number): void => {
    total -= n
    noNLBefore = Math.max(0, noNLBefore - n)
    let left = n + off
    while (left > 0 && chunks.length) {
      const c = chunks[0]
      if (left >= c.length) { left -= c.length; chunks.shift() }
      else break
    }
    off = left
  }

  const parse = (): void => {
    // Process as many complete units as are buffered; stop when we need more.
    for (;;) {
      if (total === 0) break
      // A binary frame if the stream starts with the PLOTBIN marker.
      if (total >= PLOTBIN.length && startsWithMarker()) {
        const nl = findNL(0)
        if (nl < 0) break                       // prefix line incomplete
        const prefix = extract(PLOTBIN.length, nl - PLOTBIN.length).toString('ascii')
        const [hlenS, plenS] = prefix.split(':')
        const hlen = parseInt(hlenS, 10), plen = parseInt(plenS, 10)
        if (!(hlen >= 0) || !(plen >= 0)) {     // malformed → drop the line
          consume(nl + 1); continue
        }
        const bodyStart = nl + 1
        const end = bodyStart + hlen + plen
        if (total < end) break                  // body not fully arrived yet
        let header: Record<string, unknown> = {}
        try {
          header = JSON.parse(extract(bodyStart, hlen).toString('utf8'))
        } catch { /* malformed header — still consume the frame */ }
        const payload = extract(bodyStart + hlen, plen)
        consume(end)
        try { handlers.onBinary?.(header, payload) } catch { /* ignore */ }
        continue
      }
      // Otherwise a text line up to the next '\n'.
      const nl = findNL(0)
      if (nl < 0) break                         // line incomplete
      const line = extract(0, nl).toString('utf8')
      consume(nl + 1)
      if (line.startsWith('PLOTAPP:')) {
        try {
          handlers.onMessage(JSON.parse(line.slice(8)) as Record<string, unknown>)
        } catch {
          // Say so rather than swallow it: a truncated frame is how a backend
          // bug presents, and silence turns it into "the UI just stopped".
          try {
            handlers.onStream(`[sidecar protocol] malformed JSON message: ${line.slice(0, 200)}\n`, 'stderr')
          } catch { /* ignore */ }
        }
      } else if (line.trim()) {
        try { handlers.onStream(line + '\n', 'stdout') } catch { /* ignore */ }
      }
    }
  }

  return {
    push(chunk: Buffer): void {
      if (chunk.length === 0) return
      chunks.push(chunk)
      total += chunk.length
      parse()
    },
  }
}
