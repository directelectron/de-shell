/**
 * figureBridge.react.ts — the React binding for the figure bridge.
 *
 * Split from `figureBridge.ts` so the bridge itself stays plain TypeScript:
 * it is stateful but not reactive, and keeping it free of React means it can be
 * unit-tested without a renderer.
 */
import { useEffect, useRef } from 'react'
import { createFigureBridge, type FigureBridge } from './figureBridge'

export { createFigureBridge }
export type { FigureBridge }

/**
 * One bridge per component tree, with a STABLE identity for the life of the
 * component.
 *
 * The stability matters: the bridge holds every figure's retained state, so a
 * bridge rebuilt on re-render would drop it, and any figure that had already
 * painted would go blank the next time its iframe reloaded. It is also
 * depended on by effects — a changing identity would re-run them every render.
 */
export function useFigureBridge(
  log?: (label: string, detail: Record<string, unknown>) => void,
): FigureBridge {
  const ref = useRef<FigureBridge | null>(null)
  if (ref.current === null) ref.current = createFigureBridge(log)
  return ref.current
}


/**
 * Forward anyplotlib interaction events from the figure iframes to the backend.
 *
 * An anyplotlib figure posts `{type: 'awi_event', figId, data}` up to its host
 * window when the user clicks, drags or presses a key inside it. Nothing
 * happens to that message unless someone listens and relays it — so WITHOUT
 * this hook every `plot.add_event_handler(...)` registered in Python is silently
 * dead, which is exactly how it presented: arming a measurement worked, and the
 * drag that followed reached nothing.
 *
 * Call once, high in the app. `send` is normally the preload's `figureEvent`.
 */
export function useFigureEventForwarding(
  send: (figId: string, eventJson: string) => void,
): void {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data
      if (d?.type !== 'awi_event' || !d.figId) return
      // `data` is already a JSON STRING on the wire; stringify an object form
      // rather than sending "[object Object]" down the protocol.
      send(d.figId, typeof d.data === 'string' ? d.data : JSON.stringify(d.data))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [send])
}
