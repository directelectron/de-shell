/**
 * sizeReporter.ts — dedupe for FigureFrame's size reports.
 *
 * One reporter per mounted frame. Rounds the observed rect, skips the frame's
 * zero-size first layout pass, and only lets a CHANGED size through — a
 * ResizeObserver refires on observe() and on sub-pixel wobble, and an
 * unconditional send per firing is how the Calibrate resize burst sustained
 * ~1,500 messages/s over constant geometry.
 */

export interface SizeLike {
  width: number
  height: number
}

export function createSizeReporter(
  send: (width: number, height: number) => void,
): (rect: SizeLike) => void {
  let last: string | null = null
  return (rect: SizeLike) => {
    const w = Math.round(rect.width)
    const h = Math.round(rect.height)
    if (w <= 0 || h <= 0) return
    const key = `${w}x${h}`
    if (key === last) return
    last = key
    send(w, h)
  }
}
