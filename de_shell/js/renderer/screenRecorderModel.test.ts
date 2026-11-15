import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fileName, pickRecordingType, recordingClock } from './screenRecorderModel.ts'

test('mp4 is preferred where it can be recorded', () => {
  assert.deepEqual(pickRecordingType(() => true),
    { mimeType: 'video/mp4;codecs=avc1', format: 'mp4' })
})

test('webm is the fallback, and its file is .webm', () => {
  assert.deepEqual(pickRecordingType(t => t.startsWith('video/webm')),
    { mimeType: 'video/webm;codecs=vp9', format: 'webm' })
  // Nothing listed: let MediaRecorder pick, which is webm in Chromium.
  assert.deepEqual(pickRecordingType(() => false), { mimeType: '', format: 'webm' })
})

test('the clock reads m:ss', () => {
  assert.equal(recordingClock(0), '0:00')
  assert.equal(recordingClock(65), '1:05')
  assert.equal(recordingClock(600), '10:00')
})

test('the file name is the last path segment on either separator', () => {
  assert.equal(fileName('C:\\Users\\a\\Videos\\x.mp4'), 'x.mp4')
  assert.equal(fileName('/home/a/x.webm'), 'x.webm')
})
