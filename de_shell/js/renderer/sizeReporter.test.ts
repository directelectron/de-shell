/**
 * sizeReporter.test.ts — the dedupe half of FigureFrame's resize hardening.
 *
 * The failure it prevents shipped: FigureFrame's size-report effect re-ran on
 * every parent render (inline `onResize` props make a new identity each
 * time) and sent unconditionally, so message-driven re-renders fed a resize
 * loop that sustained ~1,500 sends/s with constant geometry. The reporter is
 * the testable core: only a CHANGED rounded size goes out.
 *
 * The other half — the effect no longer re-running on `onResize` identity —
 * is wiring node:test cannot see; the e2e resize spec counts the backend's
 * applied resizes over a Calibrate mount to pin it end-to-end.
 *
 * Run by `npm run test:unit` (node:test, native TS type-stripping).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createSizeReporter } from './sizeReporter.ts'

function collector() {
  const sent: Array<[number, number]> = []
  return { sent, send: (w: number, h: number) => { sent.push([w, h]) } }
}

describe('createSizeReporter', () => {
  test('a real size is reported, rounded', () => {
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    report({ width: 353.4, height: 380.6 })
    assert.deepEqual(sent, [[353, 381]])
  })

  test('the frame\'s zero-size first layout pass is skipped', () => {
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    report({ width: 0, height: 0 })
    report({ width: 0, height: 200 })
    assert.deepEqual(sent, [])
  })

  test('an unchanged size is NOT resent — the burst mechanism', () => {
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    for (let i = 0; i < 100; i++) report({ width: 353, height: 381 })
    assert.equal(sent.length, 1)
  })

  test('a sub-pixel wobble that rounds to the same size is not resent', () => {
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    report({ width: 353.2, height: 381.1 })
    report({ width: 353.4, height: 380.8 })
    assert.equal(sent.length, 1)
  })

  test('a genuine size change IS sent — the fix\'s own failure mode', () => {
    // The one dangerous way to over-fix this: a figure that never learns its
    // new size. Required red-first by the 8-15 review's fix-4 pin.
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    report({ width: 353, height: 381 })
    report({ width: 353, height: 381 })
    report({ width: 500, height: 381 })
    assert.deepEqual(sent, [[353, 381], [500, 381]])
  })

  test('a size can recur after an intervening change', () => {
    const { sent, send } = collector()
    const report = createSizeReporter(send)
    report({ width: 100, height: 100 })
    report({ width: 200, height: 100 })
    report({ width: 100, height: 100 })
    assert.equal(sent.length, 3)
  })
})
