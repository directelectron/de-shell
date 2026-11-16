/**
 * ScreenRecorder.tsx — records the app's window to a video file, and shows a
 * "● REC 0:42 — stop" pill while it does.
 *
 * Mount it once, near the root, with the preload bridge's `recorder`. Start
 * and stop it with `toggleScreenRecording()` from a menu item's click handler,
 * or by clicking the pill. It has to start from a real click: Chromium only
 * grants `getDisplayMedia` with user activation, which a native menu item
 * routed through the main process does not carry — so the entry point is an
 * in-app menu. Main must have called `registerScreenRecorder(win)`, which is
 * what makes the capture this window and nothing else, with no picker.
 *
 * Renders nothing when idle.
 */
import React, { useEffect, useRef, useState } from 'react'

import type { RecorderApi } from './bridgeTypes'
import {
  CHUNK_MS, TOGGLE_RECORDING_EVENT, fileName, pickRecordingType, recordingClock,
} from './screenRecorderModel'
import { colors, font } from './theme'

/** Start a recording, or stop the one going. Call from a click handler. */
export function toggleScreenRecording(): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_RECORDING_EVENT))
}

export interface ScreenRecorderProps {
  recorder: RecorderApi
  /** Where the pill sits; by default the middle of the title bar, out of the
   *  way of whatever is being demonstrated. */
  style?: React.CSSProperties
}

export function ScreenRecorder({ recorder, style }: ScreenRecorderProps) {
  const active = useRef<{ stop: () => void } | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    const start = async () => {
      setNote(null)
      const { mimeType, format } = pickRecordingType(t => MediaRecorder.isTypeSupported(t))
      const path = await recorder.start(format)
      if (!path) return
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } })
      } catch (error) {
        await recorder.stop()   // removes the still-empty file
        throw error
      }
      const media = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
      // Chained rather than fired and forgotten: chunks must reach the file in
      // recording order, and awaiting each write is the backpressure too.
      let written: Promise<void> = Promise.resolve()
      media.ondataavailable = (e) => {
        if (!e.data.size) return
        written = written.then(async () => recorder.chunk(new Uint8Array(await e.data.arrayBuffer())))
      }
      media.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        try {
          await written
          const bytes = await recorder.stop()
          setNote(bytes ? `Saved ${fileName(path)}` : 'Nothing was recorded')
        } catch (error) {
          await recorder.stop().catch(() => 0)
          setNote(`Recording failed — ${(error as Error)?.message ?? error}`)
        }
      }
      const stop = () => {
        if (active.current?.stop !== stop) return
        active.current = null
        setSeconds(null)
        if (media.state !== 'inactive') media.stop()
      }
      // The capture can end on its own (the window closed, the GPU reset).
      stream.getVideoTracks().forEach(t => t.addEventListener('ended', stop))
      media.start(CHUNK_MS)
      active.current = { stop }
      setSeconds(0)
    }

    const toggle = () => {
      if (active.current) active.current.stop()
      else start().catch(e => setNote(`Recording failed — ${(e as Error)?.message ?? e}`))
    }
    window.addEventListener(TOGGLE_RECORDING_EVENT, toggle)
    return () => {
      window.removeEventListener(TOGGLE_RECORDING_EVENT, toggle)
      active.current?.stop()
    }
  }, [recorder])

  // One timeout per tick rather than an interval, so the clock can never
  // outlive the recording it is counting.
  useEffect(() => {
    if (seconds === null) return
    const id = setTimeout(() => setSeconds(seconds + 1), 1000)
    return () => clearTimeout(id)
  }, [seconds])

  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 6000)
    return () => clearTimeout(id)
  }, [note])

  if (seconds === null && !note) return null
  return (
    <button data-testid="screen-recorder-pill" style={{ ...S.pill, ...style }}
      onClick={() => (active.current ? active.current.stop() : setNote(null))}>
      {seconds === null ? note : `● REC ${recordingClock(seconds)} — stop`}
    </button>
  )
}

const S: Record<string, React.CSSProperties> = {
  // no-drag so a title bar's drag region does not swallow the click. High, but
  // below the 9000 band apps use for guided-tour overlays, which must never be
  // covered.
  pill: {
    position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 8999,
    background: colors.inset, color: colors.danger, border: `1px solid ${colors.danger}`,
    borderRadius: 999, padding: '2px 10px', fontFamily: font, fontSize: 11, cursor: 'pointer',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
}
