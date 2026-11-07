/**
 * childEnv.ts — the environment the shell passes to the processes it starts.
 */

/**
 * Variables that point Python somewhere other than the app's own environment.
 * Scientific workstations often set them for another Python: `PYTHONPATH` puts
 * a module of the same name ahead of the app's pinned dependency, and a foreign
 * `PYTHONHOME` stops the interpreter before any app code runs, with an error
 * that names neither. Windows variable names are case-insensitive.
 */
const PYTHON_REDIRECTS = /^PYTHON(PATH|HOME)$/i

/**
 * `env` without the variables that redirect Python.
 *
 * Removed from the environment rather than ignored with `python -E`: `-E`
 * would also drop the `PYTHONUNBUFFERED` the stdout protocol needs and any
 * variable a user sets on purpose (`PYTHONFAULTHANDLER`, `PYTHONUTF8`), and it
 * covers only that one interpreter, while every worker process the backend
 * starts inherits this environment.
 */
export function withoutPythonRedirects(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PYTHON_REDIRECTS.test(name)))
}
