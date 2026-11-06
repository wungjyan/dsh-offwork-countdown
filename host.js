/**
 * dsh-offwork-countdown — Host half.
 *
 * The floating pill itself lives in the page (client.js). This half owns the one
 * thing a browser tab cannot own reliably: the settings. The Harness Web GUI is
 * served from 127.0.0.1 on a port that changes between launches, and
 * `localStorage` is keyed by origin, so a saved schedule would silently come
 * back as the default after a restart. A small JSON file under `DSH_HOME`
 * (default `~/.dsh`) is stable across ports, restarts and browser profiles.
 *
 * Two same-origin routes carry it, the transport the installed community plugins
 * `dshmarket` and `better-dsh-session-deletetool` use for their own UI→Host
 * calls: a build-free plain-JavaScript bundle cannot declare a typed
 * `ctx.remote` namespace, because those need generated Typert descriptors.
 *
 *   GET  /dsh-offwork-countdown/state  → { ok, state }
 *   POST /dsh-offwork-countdown/state  → { ok, state }  (validated partial patch)
 *
 * The Host validates every field before writing: a stale page, a hand-written
 * request or a newer client must never persist a value the countdown would
 * misread, and every refusal carries a stable code plus a message the panel
 * shows as-is.
 *
 * Per-day marks (`clockedInOn`, `dismissedOn`) name the date the SHIFT STARTS,
 * not the calendar day the click happened. A night shift starting 22:00 Monday
 * and ending 06:00 Tuesday keeps one identity — `2026-11-02` — so a dismissal
 * typed at 06:30 Tuesday cannot silence anything else, and Tuesday's 22:00
 * shift is a different mark.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Activating requires the HTTP carrier; everything else is node built-ins. */
export const inject = ['webServer']

const STATE_PATH = '/dsh-offwork-countdown/state'

/** A settings document is tiny; anything larger is not ours. */
const MAX_BODY_BYTES = 8192

/**
 * The corners the pill may dock to. Kept alongside free dragging as presets:
 * a fresh install lands on one, and the panel still offers them as shortcuts.
 */
const POSITIONS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])

/** The built-in accents, mirroring the palette the panel draws. */
const ACCENTS = new Set(['red', 'orange', 'amber', 'rose', 'violet', 'blue', 'cyan', 'green', 'slate'])

/** `HH:MM`, 24-hour, zero-padded — the value an `<input type="time">` emits. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `YYYY-MM-DD`, the shift-start calendar day a mark belongs to. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A per-shift mark: the start day plus the shift's own shape.
 *
 * `2026-11-05|09:00|18:00`. The shape is part of the identity because the marks
 * must describe one shift, not one day: changing the shift's times produces a
 * different shift, and a dismissal or clock-in earned by the old one has to stop
 * applying to it.
 *
 * The bare-date form is still ACCEPTED here but is no longer read as a match —
 * the Client drops it. That is not compatibility for its own sake: `readState`
 * falls back to the defaults when validation throws, so refusing the old form
 * here would reset every setting of any user whose file still holds one.
 */
const PRINT_PATTERN = /^\d{4}-\d{2}-\d{2}\|([01]\d|2[0-3]):([0-5]\d)\|([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Whether a mark value is one this plugin wrote.
 * @param {string} value - the candidate.
 * @returns {boolean} true for a bare date or a full shift print.
 */
function isMark(value) {
  return DATE_PATTERN.test(value) || PRINT_PATTERN.test(value)
}

/** `#rrggbb`, the one custom colour format the panel's picker emits. */
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/

/** The breathing paces the panel offers, in seconds. */
const PACES = new Set([1.2, 1.8, 3])

/**
 * What a fresh install starts with: 09:00 in, 18:00 out, a 15-minute heads-up
 * before leaving, Monday through Friday, in the bottom-right corner, red.
 */
const DEFAULTS = Object.freeze({
  startTime: '09:00',
  endTime: '18:00',
  leadMinutes: 15,
  workdays: Object.freeze([1, 2, 3, 4, 5]),
  position: 'bottom-right',
  spot: null,
  enabled: true,
  clockedInOn: null,
  dismissedOn: null,
  accentColor: 'red',
  pulseSeconds: 1.8,
  remindWindowMinutes: 240,
})

/** A refusal carrying the HTTP status and the stable code the panel reports. */
class StateRefusal extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'StateRefusal'
    this.status = status
    this.code = code
  }
}

/**
 * The Harness data root: `DSH_HOME` when the environment sets one, else
 * `~/.dsh`. Resolved per request so a profile launched with a different root
 * keeps its own settings.
 * @returns {string} absolute data root.
 */
function dataRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * The settings document this plugin owns.
 * @returns {string} absolute path to `state.json`.
 */
function stateFile() {
  return join(dataRoot(), 'offwork-countdown', 'state.json')
}

/**
 * Register the settings routes.
 * @param {object} ctx - Host Cordis context.
 */
export function apply(ctx) {
  const onState = (request, response) => {
    void serveState(ctx, request, response).catch((error) => {
      // A refusal is a client mistake with a stable code the panel shows as-is;
      // anything else is ours, so it is logged and reported generically.
      if (error instanceof StateRefusal) {
        send(response, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      ctx.logger?.warn?.(`[dsh-offwork-countdown] route failure: ${messageOf(error)}`)
      send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
    })
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: onState }),
    'dsh-offwork-countdown: state route',
  )
  ctx.logger?.info?.(`[dsh-offwork-countdown] settings mounted at ${STATE_PATH} (${stateFile()})`)
}

/**
 * Own one settings request end to end: GET reads, POST merges and persists.
 * @param {object} ctx - Host Cordis context.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveState(ctx, request, response) {
  // A repaired value is otherwise invisible: the request succeeds, the page
  // draws the default, and nothing says why. One warning line per read is
  // enough to diagnose it from the Host log.
  const reportRepair = (fields) => {
    ctx.logger?.warn?.(
      `[dsh-offwork-countdown] ${stateFile()} held values this build cannot use; ${fields.join(', ')} fell back to the defaults, everything else was kept`,
    )
  }
  if (request.method === 'GET') {
    const current = await readState(reportRepair)
    send(response, 200, { ok: true, state: current })
    return
  }
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only GET and POST are accepted' })
    return
  }
  const body = await readBody(request)
  let patch
  try {
    patch = JSON.parse(body)
  } catch {
    throw new StateRefusal(400, 'invalid-json', 'request body is not valid JSON')
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new StateRefusal(400, 'invalid-shape', 'request body must be a JSON object')
  }
  const current = await readState(reportRepair)
  const next = mergeState(current, patch)
  await writeState(next)
  ctx.logger?.info?.(`[dsh-offwork-countdown] settings saved: ${describeState(next)}`)
  send(response, 200, { ok: true, state: next })
}

/**
 * Read the stored settings.
 *
 * Missing, unreadable and unparseable files fall back to the defaults; nothing
 * else can be salvaged from them. A file that parses but holds a value this
 * build refuses is repaired group by group instead — see `repairState` for why
 * the whole document must not be discarded.
 * @param {(fields: string[]) => void} [onRepair] - told which fields fell back.
 * @returns {Promise<object>} a complete, validated settings document.
 */
async function readState(onRepair) {
  let raw
  try {
    raw = await readFile(stateFile(), 'utf8')
  } catch {
    return structuredClone(DEFAULTS)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return structuredClone(DEFAULTS)
  }
  // A document is an object; `null`, an array or a scalar carries no field to
  // salvage, so it is treated exactly like a file that failed to parse.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return structuredClone(DEFAULTS)
  }
  try {
    return mergeState(DEFAULTS, parsed)
  } catch {
    // The file parsed but held at least one value this build refuses. Falling
    // back wholesale here would throw away settings that are perfectly good —
    // and the next write would then persist the defaults over them, making the
    // loss permanent. Salvage what still validates instead.
    return repairState(parsed, onRepair)
  }
}

/**
 * The fields that are kept or discarded together.
 *
 * A group is the unit because its fields only mean anything as a set: a start
 * time without its end time describes no shift, and keeping half the old pair
 * would invent a shift the user never chose. Everything else stands alone, so
 * one unreadable value costs exactly one setting.
 */
const REPAIR_GROUPS = [
  ['startTime', 'endTime'],
  ['leadMinutes'],
  ['workdays'],
  ['enabled'],
  ['position'],
  ['spot'],
  ['clockedInOn'],
  ['dismissedOn'],
  ['accentColor'],
  ['pulseSeconds'],
  ['remindWindowMinutes'],
]

/**
 * Rebuild a usable document from one that failed validation.
 *
 * Each group is merged onto the defaults through the same `mergeState` a write
 * goes through, so a salvaged document is exactly as valid as a written one:
 * the next read accepts it without repairing again, and the result does not
 * depend on how many times it is read.
 *
 * This repairs VALUES, not their meaning. A mark in an older format is still
 * returned as it was found — deciding it no longer matches a shift stays the
 * Client's job, so upgrading never silently rewrites what the user recorded.
 * @param {object} stored - the parsed file, known to fail validation.
 * @param {(fields: string[]) => void} [onRepair] - told which fields fell back.
 * @returns {object} a complete, validated settings document.
 */
function repairState(stored, onRepair) {
  let state = structuredClone(DEFAULTS)
  const dropped = []
  for (const group of REPAIR_GROUPS) {
    const patch = {}
    for (const key of group) {
      if (stored[key] !== undefined) patch[key] = stored[key]
    }
    if (Object.keys(patch).length === 0) continue
    try {
      state = mergeState(state, patch)
    } catch {
      dropped.push(...group)
    }
  }
  if (dropped.length > 0 && typeof onRepair === 'function') onRepair(dropped)
  return state
}

/**
 * Persist the settings, creating the data directory on first write. The write
 * goes through a temporary sibling so an interrupted save cannot leave a
 * half-written document behind.
 * @param {object} state - the complete document.
 * @returns {Promise<void>} resolution after the rename.
 */
async function writeState(state) {
  const path = stateFile()
  await mkdir(join(dataRoot(), 'offwork-countdown'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Merge a validated patch over a complete document.
 *
 * Every field is checked against the same rules the panel enforces, so a stale
 * page, a hand-written request or a newer client cannot store a value the
 * countdown would misread. Unknown keys are dropped rather than stored.
 * @param {object} current - the document to start from.
 * @param {object} patch - the fields to change.
 * @returns {object} the next complete document.
 * @throws {StateRefusal} when a supplied field is not acceptable.
 */
function mergeState(current, patch) {
  const next = {
    startTime: current.startTime,
    endTime: current.endTime,
    leadMinutes: current.leadMinutes,
    workdays: [...current.workdays],
    position: current.position,
    spot: current.spot === null ? null : { ...current.spot },
    enabled: current.enabled,
    clockedInOn: current.clockedInOn,
    dismissedOn: current.dismissedOn,
    accentColor: current.accentColor,
    pulseSeconds: current.pulseSeconds,
    remindWindowMinutes: current.remindWindowMinutes,
  }
  if (patch.startTime !== undefined) {
    if (typeof patch.startTime !== 'string' || !TIME_PATTERN.test(patch.startTime)) {
      throw new StateRefusal(400, 'invalid-start-time', 'startTime must be a 24-hour HH:MM string')
    }
    next.startTime = patch.startTime
  }
  if (patch.endTime !== undefined) {
    if (typeof patch.endTime !== 'string' || !TIME_PATTERN.test(patch.endTime)) {
      throw new StateRefusal(400, 'invalid-end-time', 'endTime must be a 24-hour HH:MM string')
    }
    next.endTime = patch.endTime
  }
  // A shift with no duration has no meaningful countdown. Equal times are
  // refused here rather than silently treated as a 24-hour shift.
  if (next.startTime === next.endTime) {
    throw new StateRefusal(400, 'empty-shift', 'startTime and endTime must differ')
  }
  if (patch.leadMinutes !== undefined) {
    const value = patch.leadMinutes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 180) {
      throw new StateRefusal(400, 'invalid-lead', 'leadMinutes must be an integer between 0 and 180')
    }
    next.leadMinutes = value
  }
  if (patch.workdays !== undefined) {
    if (!Array.isArray(patch.workdays)) {
      throw new StateRefusal(400, 'invalid-workdays', 'workdays must be an array of ISO weekday numbers')
    }
    const days = new Set()
    for (const day of patch.workdays) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
        throw new StateRefusal(400, 'invalid-workdays', 'workdays must contain integers between 1 (Monday) and 7 (Sunday)')
      }
      days.add(day)
    }
    if (days.size === 0) {
      throw new StateRefusal(400, 'invalid-workdays', 'workdays must contain at least one day')
    }
    next.workdays = [...days].sort((left, right) => left - right)
  }
  if (patch.position !== undefined) {
    if (typeof patch.position !== 'string' || !POSITIONS.has(patch.position)) {
      throw new StateRefusal(400, 'invalid-position', 'position must be one of bottom-right, bottom-left, top-right, top-left')
    }
    next.position = patch.position
    // Choosing a corner is a preset: it clears the free-drag position so the two
    // cannot disagree about where the pill belongs.
    next.spot = null
  }
  // A free-drag position, stored as a fraction of the pill's travel range rather
  // than as pixels. The range is (window - pill), so 1 always means "flush
  // against the right/bottom edge" no matter how the window is resized — a pixel
  // offset saved in a wide window would fall outside a narrow one.
  if (patch.spot !== undefined) {
    if (patch.spot === null) {
      next.spot = null
    } else {
      if (typeof patch.spot !== 'object' || Array.isArray(patch.spot)) {
        throw new StateRefusal(400, 'invalid-spot', 'spot must be null or an { x, y } object')
      }
      const { x, y } = patch.spot
      const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      if (!usable(x) || !usable(y)) {
        throw new StateRefusal(400, 'invalid-spot', 'spot.x and spot.y must be numbers between 0 and 1')
      }
      next.spot = { x, y }
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new StateRefusal(400, 'invalid-enabled', 'enabled must be a boolean')
    }
    next.enabled = patch.enabled
  }
  if (patch.accentColor !== undefined) {
    const value = patch.accentColor
    const isPreset = typeof value === 'string' && ACCENTS.has(value)
    const isHex = typeof value === 'string' && HEX_PATTERN.test(value)
    if (!isPreset && !isHex) {
      throw new StateRefusal(400, 'invalid-accent', 'accentColor must be a preset name or a #rrggbb colour')
    }
    // A custom colour is stored lower-cased so two writes of the same picker
    // value cannot produce two different documents.
    next.accentColor = isHex ? value.toLowerCase() : value
  }
  if (patch.pulseSeconds !== undefined) {
    const value = patch.pulseSeconds
    if (typeof value !== 'number' || !PACES.has(value)) {
      throw new StateRefusal(400, 'invalid-pulse', 'pulseSeconds must be one of 1.2, 1.8, 3')
    }
    next.pulseSeconds = value
  }
  if (patch.remindWindowMinutes !== undefined) {
    const value = patch.remindWindowMinutes
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 15 || value > 720) {
      throw new StateRefusal(400, 'invalid-remind-window', 'remindWindowMinutes must be an integer between 15 and 720')
    }
    next.remindWindowMinutes = value
  }
  // Per-day marks: null clears, a date string sets. They name a shift start day,
  // so any well-formed date is accepted — the client decides whether it matches
  // the shift on screen.
  if (patch.clockedInOn !== undefined) {
    if (patch.clockedInOn !== null && (typeof patch.clockedInOn !== 'string' || !isMark(patch.clockedInOn))) {
      throw new StateRefusal(400, 'invalid-clocked-in', 'clockedInOn must be null, YYYY-MM-DD, or YYYY-MM-DD|HH:MM|HH:MM')
    }
    next.clockedInOn = patch.clockedInOn
  }
  if (patch.dismissedOn !== undefined) {
    if (patch.dismissedOn !== null && (typeof patch.dismissedOn !== 'string' || !isMark(patch.dismissedOn))) {
      throw new StateRefusal(400, 'invalid-dismissed', 'dismissedOn must be null, YYYY-MM-DD, or YYYY-MM-DD|HH:MM|HH:MM')
    }
    next.dismissedOn = patch.dismissedOn
  }
  return next
}

/**
 * Read a request body with a hard ceiling.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<string>} the decoded body.
 * @throws {StateRefusal} when the body is too large.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new StateRefusal(413, 'body-too-large', 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} payload - the body.
 */
function send(response, status, payload) {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Render one settings document for the host log.
 * @param {object} state - the document.
 * @returns {string} a one-line summary.
 */
function describeState(state) {
  const where = state.spot === null ? state.position : `spot(${state.spot.x.toFixed(3)},${state.spot.y.toFixed(3)})`
  return `shift=${state.startTime}->${state.endTime} lead=${state.leadMinutes}m workdays=${state.workdays.join(',')} accent=${state.accentColor} pulse=${state.pulseSeconds}s window=${state.remindWindowMinutes}m at=${where} enabled=${state.enabled}`
}

/**
 * Read one error's text.
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
