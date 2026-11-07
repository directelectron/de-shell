/**
 * childEnv.test.ts — the variables that redirect Python never reach a child.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withoutPythonRedirects } from './childEnv.ts'

test('PYTHONPATH and PYTHONHOME are removed, in any case', () => {
  const env = withoutPythonRedirects({
    PYTHONPATH: 'shadow', PythonHome: 'elsewhere', pythonpath: 'shadow', Path: 'C:\bin',
  })
  assert.deepEqual(env, { Path: 'C:\bin' })
})

test('other Python variables a user sets on purpose are kept', () => {
  const kept = { PYTHONFAULTHANDLER: '1', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONPATHS: 'x' }
  assert.deepEqual(withoutPythonRedirects(kept), kept)
})
