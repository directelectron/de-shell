/**
 * stdoutDemux.test.ts — node:test unit tests for the backend stdout demuxer.
 *
 * The stream interleaves '\n'-terminated text lines (PLOTAPP: JSON + plain
 * log output) with raw PLOTBIN binary frames
 * (PLOTBIN:<hlen>:<plen>\n<header_json><payload>). The demuxer must produce
 * the SAME event trace regardless of how the OS slices the stream into
 * 'data' chunks — Windows delivers a single large child-stdout write as
 * uniform 64 KiB chunks (measured 2026-08-15), and chunk boundaries can land
 * mid-marker, mid-prefix, mid-header or mid-payload.
 *
 * Also pins the accumulator's cost shape: a 16 MB frame arriving as 64 KiB
 * chunks must demux in linear time. The pre-fix Buffer.concat accumulator
 * recopied the whole prefix per chunk — O(N²/chunk): measured 813 ms at
 * 16 MB, 11.9 s at 64 MB (notes/runs/2026-08-15-perf-review-measurements.md
 * §1) — so the 250 ms budget is ~3× under the old cost and ~38× over the
 * chunk-list cost (6.6 ms measured); generous against CI timer noise on
 * both sides.
 *
 * Run: `node --test src/stdoutDemux.test.ts` (from packages/shell-main/),
 * or via the `test:unit` npm script.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStdoutDemux } from './stdoutDemux.ts'

type Event =
  | { kind: 'message'; msg: Record<string, unknown> }
  | { kind: 'stream'; text: string }
  | { kind: 'binary'; header: Record<string, unknown>; payload: string }

function collector() {
  const events: Event[] = []
  const demux = createStdoutDemux({
    onMessage: (msg) => events.push({ kind: 'message', msg }),
    onStream: (text) => events.push({ kind: 'stream', text }),
    onBinary: (header, payload) =>
      events.push({ kind: 'binary', header, payload: payload.toString('hex') }),
  })
  return { events, demux }
}

function frame(header: Record<string, unknown>, payload: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8')
  return Buffer.concat([
    Buffer.from(`PLOTBIN:${h.length}:${payload.length}\n`, 'ascii'),
    h,
    payload,
  ])
}

/** Feed `stream` in slices of `sizes` (cycled); return the event trace. */
function run(stream: Buffer, sizes: number[]): Event[] {
  const { events, demux } = collector()
  let pos = 0
  let i = 0
  while (pos < stream.length) {
    const n = Math.min(sizes[i % sizes.length], stream.length - pos)
    demux.push(stream.subarray(pos, pos + n))
    pos += n
    i++
  }
  return events
}

function patternPayload(n: number): Buffer {
  const p = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) p[i] = i & 0xff // includes 0x0a bytes
  return p
}

// A representative interleaved stream: log line, PLOTAPP message, a binary
// frame whose payload contains newline bytes and marker-lookalike bytes,
// another log line, a second frame back-to-back with a third, final message.
function interleavedStream(): Buffer {
  const nasty = Buffer.concat([
    Buffer.from('\nPLOTBIN:9:9\nPLOTAPP:{}\n', 'ascii'), // lookalikes INSIDE payload
    patternPayload(3000),
  ])
  return Buffer.concat([
    Buffer.from('starting up\n', 'utf8'),
    Buffer.from('PLOTAPP:{"type":"state_update","key":"clim"}\n', 'utf8'),
    frame({ fig_id: 'f1', key: 'image' }, nasty),
    Buffer.from('mid-run log\n', 'utf8'),
    frame({ fig_id: 'f2', key: 'image' }, patternPayload(1)),
    frame({ fig_id: 'f3', key: 'spec' }, Buffer.alloc(0)),
    Buffer.from('PLOTAPP:{"type":"done"}\n', 'utf8'),
  ])
}

test('one whole-stream chunk parses every unit in order', () => {
  const events = run(interleavedStream(), [1 << 30])
  assert.deepEqual(events.map((e) => e.kind),
    ['stream', 'message', 'binary', 'stream', 'binary', 'binary', 'message'])
  const b1 = events[2] as Extract<Event, { kind: 'binary' }>
  assert.deepEqual(b1.header, { fig_id: 'f1', key: 'image' })
  const b3 = events[5] as Extract<Event, { kind: 'binary' }>
  assert.equal(b3.payload, '')
  assert.deepEqual((events[6] as Extract<Event, { kind: 'message' }>).msg,
    { type: 'done' })
})

test('the event trace is chunking-invariant (64 KiB, tiny, 1-byte, ragged)', () => {
  const stream = interleavedStream()
  const reference = run(stream, [1 << 30])
  for (const sizes of [[65536], [7], [1], [3, 1, 40, 2, 1000, 1]]) {
    assert.deepEqual(run(stream, sizes), reference,
      `trace diverged for chunk sizes ${JSON.stringify(sizes)}`)
  }
})

test('splits inside the marker, prefix, header and payload all reassemble', () => {
  const f = frame({ fig_id: 'x' }, patternPayload(64))
  const reference = run(f, [1 << 30])
  // Split at every single boundary position of the frame — brute force
  // covers mid-marker, mid-prefix, mid-header and mid-payload by exhaustion.
  for (let cut = 1; cut < f.length; cut++) {
    const { events, demux } = collector()
    demux.push(f.subarray(0, cut))
    demux.push(f.subarray(cut))
    assert.deepEqual(events, reference, `split at byte ${cut} diverged`)
  }
})

test('a malformed PLOTBIN prefix line is dropped and parsing resumes', () => {
  const stream = Buffer.concat([
    Buffer.from('PLOTBIN:not:numbers\n', 'ascii'),
    Buffer.from('PLOTAPP:{"type":"after"}\n', 'utf8'),
  ])
  for (const sizes of [[1 << 30], [1]]) {
    const events = run(stream, sizes)
    assert.deepEqual(events, [
      { kind: 'message', msg: { type: 'after' } },
    ])
  }
})

test('a malformed header still consumes the frame and delivers the payload', () => {
  const h = Buffer.from('{broken', 'utf8')
  const payload = patternPayload(32)
  const stream = Buffer.concat([
    Buffer.from(`PLOTBIN:${h.length}:${payload.length}\n`, 'ascii'),
    h, payload,
    Buffer.from('PLOTAPP:{"type":"after"}\n', 'utf8'),
  ])
  const events = run(stream, [5])
  assert.deepEqual(events, [
    { kind: 'binary', header: {}, payload: payload.toString('hex') },
    { kind: 'message', msg: { type: 'after' } },
  ])
})

test('malformed PLOTAPP JSON is reported, not swallowed; blank lines emit nothing', () => {
  // A truncated frame is how a backend bug presents, and silence turns it
  // into "the UI just stopped" — so the line is dropped AND said so, on
  // stderr, and the parse carries on to the next unit.
  const stream = Buffer.from('PLOTAPP:{nope\n\n   \nreal log\n', 'utf8')
  const events = run(stream, [2])
  assert.equal(events.length, 2)
  assert.match((events[0] as { text?: string }).text ?? '',
               /^\[sidecar protocol\] malformed JSON message: PLOTAPP:\{nope/)
  assert.deepEqual(events[1], { kind: 'stream', text: 'real log\n' })
})

test('a handler that throws does not stop the parse', () => {
  const seen: string[] = []
  const demux = createStdoutDemux({
    onMessage: (m) => { seen.push(`m:${(m as { type?: string }).type}`) },
    onStream: () => { throw new Error('boom') },
    onBinary: () => { throw new Error('boom') },
  })
  demux.push(Buffer.concat([
    Buffer.from('log line\n', 'utf8'),
    frame({ fig_id: 'f' }, patternPayload(8)),
    Buffer.from('PLOTAPP:{"type":"after"}\n', 'utf8'),
  ]))
  assert.deepEqual(seen, ['m:after'])
})

test('PERF PIN: a 16 MB frame in 64 KiB chunks demuxes in linear time', () => {
  const payload = Buffer.allocUnsafe(16 * 1024 * 1024).fill(7)
  const stream = frame({ fig_id: 'big', key: 'image' }, payload)
  const { events, demux } = collector()
  const t0 = process.hrtime.bigint()
  for (let pos = 0; pos < stream.length; pos += 65536) {
    demux.push(stream.subarray(pos, Math.min(pos + 65536, stream.length)))
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(events.length, 1)
  assert.equal((events[0] as Extract<Event, { kind: 'binary' }>).payload.length,
    payload.length * 2) // hex doubles
  assert.ok(ms < 250,
    `16 MB frame took ${ms.toFixed(0)} ms — the quadratic Buffer.concat ` +
    `accumulator signature (measured 813 ms pre-fix, 6.6 ms chunk-list)`)
})
