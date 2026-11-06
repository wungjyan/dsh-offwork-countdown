/**
 * dsh-offwork-countdown — Client half.
 *
 * One pill in the frame-wide overlay layer that walks a workday through its
 * shift, plus the settings panel it opens. It registers into `shell.overlay`,
 * the layer the app frame declares for exactly this: a frame-wide surface of its
 * own, above every column and outside their scroll containers. The layer is
 * click-through and each occupant opts back in, so the pill never blocks the app
 * underneath.
 *
 * The phases a shift walks through:
 *
 *   waiting  — the shift has started but today's clock-in has not been marked.
 *              The pill shows the start time and a 「打卡」 button, which is
 *              itself the reminder to clock in.
 *   working  — clocked in, before the heads-up window; quiet, theme-token colours
 *   soon     — inside the heads-up window (default 15 min); the accent tinted
 *              into the card at low strength, same colour as `due` below
 *   due      — the shift has ended; the accent colour fills the card and the pill
 *              breathes. Shown whether or not the day was clocked in: forgetting
 *              to clock in must not cost the user the reminder that matters most.
 *   idle     — on screen but nothing to act on: before the shift, after it, on
 *              a rest day, or once a reminder was dismissed. A dimmed pill names
 *              the NEXT shift relative to today («今天 09:00 上班»,
 *              «明天 09:00 上班», «周一 09:00 上班»). It stays visible on
 *              purpose: a widget that vanishes reads as a broken plugin, and a
 *              bare "09:00 上班" would announce a shift that never runs at the
 *              weekend.
 *   hidden   — only when the user switches the pill off. This is the one case
 *              where drawing nothing is what was asked for.
 *
 * ## Why the action button does not say 「已打卡」
 *
 * It said that once, and a colleague read it as a status readout rather than a
 * control — the pill sat there announcing a state that had not happened yet. Two
 * things made it read that way, and both are fixed:
 *
 *   - The label was past tense. 「已打卡」 states a completed fact; 「打卡」 is the
 *     action, and the word DingTalk and every other Chinese time clock puts on
 *     the button you press.
 *   - The shape was a capsule (`border-radius:999px`) — which is this product's
 *     *status tag* shape (`.pill` in the app shell), not its button shape. Real
 *     buttons here use `--dsw-radius-sm` (8px). A round chip inside a round pill
 *     reads as decoration; a rounded rectangle reads as something to press.
 *
 * ## The shift model (this is what makes night shifts work)
 *
 * A shift is an interval [start, end] anchored to a date, and it belongs to the
 * day it STARTS. When `startTime >= endTime` the interval crosses midnight, so
 * it ends on the following calendar day. Nothing else differs: the phase maths
 * runs over the same interval either way.
 *
 * A shift's identity is its start day PLUS its shape — `2026-11-02|22:00|06:00` —
 * and that is exactly what the marks (`clockedInOn`, `dismissedOn`) store. The
 * start date alone is not enough: changing 09:00-18:00 to 15:00-18:00 and back
 * produces three different shifts on one calendar day, and a mark has to describe
 * one of them. Against the date alone, a dismissal earned by the 15:00 shift
 * silenced the 09:00 shift for the rest of the day — which is the bug this
 * fingerprint format exists to prevent.
 *
 * The consequence is deliberate: editing the shift's times makes it a different
 * shift, so the clock-in has to be repeated. Switching the times back restores
 * the mark, because the fingerprint matches again.
 *
 * A mark in the older bare-date form (`2026-11-02`) is dropped on read rather
 * than matched loosely. Matching it loosely would mean one date matches every
 * shift that day — exactly the bug above — and it would never stop doing so for
 * as long as that date was "today". Dropping costs one repeat clock-in on the
 * upgrade day; the alternative silently swallows the alert this plugin exists
 * to give.
 *
 * ## The reminder window
 *
 * Once a shift ends, the `due` phase does NOT stay forever: it lasts at most
 * `remindWindowMinutes` (default 240). Without that bound a night shift ending
 * 06:00 would still report "time to clock out" at 21:00 that evening, right
 * before the next shift. The window also stops the pill from nagging at midnight
 * after an 18:00 finish.
 *
 * Motion is suppressed under the operating system's reduced-motion preference,
 * where the colour and the text still carry the meaning.
 *
 * Settings live in the Host half (see host.js) rather than `localStorage`: the
 * Web GUI is served from a port that changes between launches, and a tab's
 * storage is keyed by origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-offwork-countdown',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const NS = 'dsh-offwork-countdown'
    const STATE_PATH = '/dsh-offwork-countdown/state'

    /** The npm package name this bundle installs as; the detail page keys on it. */
    const PACKAGE_NAME = 'dsh-offwork-countdown'

    /** Copy for both locales. The Host never reads these; they are the page's. */
    const DICT = {
      zh: {
        'pill.waiting': '{start} 上班',
        'pill.endAt': '{time} 下班',
        'pill.soon': '快下班了 · {time}',
        'pill.remaining': '还有 {delta}',
        'delta.hm': '{h} 小时 {m} 分',
        'delta.ms': '{m} 分 {s} 秒',
        'delta.s': '{s} 秒',
        'pill.due': '下班时间到了，记得打卡',
        // The idle card. `{when}` is a relative day («今天»/«明天»/«周一»), so
        // the line stays true on a rest day instead of announcing a shift that
        // will not run.
        'pill.idle.today': '今天 {start} 上班',
        'pill.idle.tomorrow': '明天 {start} 上班',
        'pill.idle.weekday': '{day} {start} 上班',
        'pill.idle.none': '暂无排班',
        'act.clockIn': '打卡',
        'act.known': '知道了',
        'panel.title': '打卡提醒',
        'panel.subtitle': '到点后浮窗会变色并轻轻呼吸，提醒你打卡。',
        'panel.settingsHead': '设置',
        'panel.settingsHint': '改完立即生效，不需要保存。',
        'panel.sectionTime': '班次时间',
        'panel.startTime': '上班时间',
        'panel.endTime': '下班时间',
        'panel.overnight': '夜班（跨零点）',
        'panel.sectionWarn': '提醒节奏',
        'panel.lead': '提前提醒',
        'panel.leadValue': '提前 {n} 分钟',
        'panel.leadNone': '到点才提醒',
        'panel.pulseLabel': '呼吸节奏',
        'panel.pulseFast': '快（1.2 秒）',
        'panel.pulseNormal': '中（1.8 秒）',
        'panel.pulseSlow': '慢（3 秒）',
        'panel.windowLabel': '提醒有效期',
        'panel.windowValue': '{n} 小时',
        'panel.windowHint': '下班后最多提醒这么久，超时自动安静。',
        'panel.workdays': '提醒日',
        'panel.sectionLook': '外观',
        'panel.accent': '提醒颜色',
        'panel.custom': '自定义',
        'panel.position': '挂件位置',
        'panel.dragHint': '也可以直接把浮窗拖到任意位置。',
        'panel.resetSpot': '恢复角落',
        'panel.enabled': '显示浮窗',
        'panel.close': '关闭',
        'panel.loading': '正在读取设置…',
        'panel.failed': '保存失败：{message}',
        'panel.loadFailed': '读取设置失败，先按默认值显示。',
        'panel.retry': '重试',
        'panel.hint': '设置保存在本机，重启后仍然有效。',
        'panel.daysRequired': '至少保留一天。',
        'panel.shiftInvalid': '上班和下班时间不能相同。',
        'panel.clockInHint': '每天点一次「打卡」，浮窗才开始显示下班倒计时。',
        'panel.shiftResetsMark': '改时间等于换了一个班次，今天要重新打卡。',
        'day.1': '一',
        'day.2': '二',
        'day.3': '三',
        'day.4': '四',
        'day.5': '五',
        'day.6': '六',
        'day.7': '日',
        // Full weekday names for the idle line — `day.N` is a one-glyph column
        // header for the weekday picker and reads wrong inside a sentence.
        'week.1': '周一',
        'week.2': '周二',
        'week.3': '周三',
        'week.4': '周四',
        'week.5': '周五',
        'week.6': '周六',
        'week.7': '周日',
        'pos.bottom-right': '右下角',
        'pos.bottom-left': '左下角',
        'pos.top-right': '右上角',
        'pos.top-left': '左上角',
        'open': '打开打卡设置',
        'color.red': '红',
        'color.orange': '橙',
        'color.amber': '琥珀',
        'color.rose': '玫红',
        'color.violet': '紫',
        'color.blue': '蓝',
        'color.cyan': '青',
        'color.green': '绿',
        'color.slate': '深灰',
      },
      en: {
        'pill.waiting': 'Starts at {start}',
        'pill.endAt': 'Off at {time}',
        'pill.soon': 'Off soon · {time}',
        'pill.remaining': '{delta} left',
        'delta.hm': '{h}h {m}m',
        'delta.ms': '{m}m {s}s',
        'delta.s': '{s}s',
        'pill.due': 'Time to clock out',
        'pill.idle.today': 'Starts today at {start}',
        'pill.idle.tomorrow': 'Starts tomorrow at {start}',
        'pill.idle.weekday': 'Starts {day} at {start}',
        'pill.idle.none': 'No shift scheduled',
        'act.clockIn': 'Clock in',
        'act.known': 'Got it',
        'panel.title': 'Clock reminder',
        'panel.subtitle': 'When the time comes the pill fills with colour and breathes, so you do not forget to clock out.',
        'panel.settingsHead': 'Settings',
        'panel.settingsHint': 'Changes apply at once; there is nothing to save.',
        'panel.sectionTime': 'Shift',
        'panel.startTime': 'Starts',
        'panel.endTime': 'Ends',
        'panel.overnight': 'Night shift (crosses midnight)',
        'panel.sectionWarn': 'Reminders',
        'panel.lead': 'Heads-up',
        'panel.leadValue': '{n} min before',
        'panel.leadNone': 'At the time only',
        'panel.pulseLabel': 'Breathing pace',
        'panel.pulseFast': 'Fast (1.2 s)',
        'panel.pulseNormal': 'Medium (1.8 s)',
        'panel.pulseSlow': 'Slow (3 s)',
        'panel.windowLabel': 'Reminder lasts',
        'panel.windowValue': '{n} h',
        'panel.windowHint': 'After the shift ends the pill reminds for at most this long, then goes quiet.',
        'panel.workdays': 'Remind on',
        'panel.sectionLook': 'Appearance',
        'panel.accent': 'Colour',
        'panel.custom': 'Custom',
        'panel.position': 'Corner',
        'panel.dragHint': 'You can also drag the pill anywhere you like.',
        'panel.resetSpot': 'Reset',
        'panel.enabled': 'Show the pill',
        'panel.close': 'Close',
        'panel.loading': 'Reading settings…',
        'panel.failed': 'Could not save: {message}',
        'panel.loadFailed': 'Could not read the settings; showing defaults.',
        'panel.retry': 'Retry',
        'panel.hint': 'Stored on this machine, so it survives a restart.',
        'panel.daysRequired': 'Keep at least one day.',
        'panel.shiftInvalid': 'Start and end times must differ.',
        'panel.clockInHint': 'Clock in once a day and the pill starts counting down to the end of your shift.',
        'panel.shiftResetsMark': 'Changing the times makes it a different shift, so today needs a new clock-in.',
        'day.1': 'M',
        'day.2': 'T',
        'day.3': 'W',
        'day.4': 'T',
        'day.5': 'F',
        'day.6': 'S',
        'day.7': 'S',
        'week.1': 'on Monday',
        'week.2': 'on Tuesday',
        'week.3': 'on Wednesday',
        'week.4': 'on Thursday',
        'week.5': 'on Friday',
        'week.6': 'on Saturday',
        'week.7': 'on Sunday',
        'pos.bottom-right': 'Bottom right',
        'pos.bottom-left': 'Bottom left',
        'pos.top-right': 'Top right',
        'pos.top-left': 'Top left',
        'open': 'Open clock settings',
        'color.red': 'Red',
        'color.orange': 'Orange',
        'color.amber': 'Amber',
        'color.rose': 'Rose',
        'color.violet': 'Violet',
        'color.blue': 'Blue',
        'color.cyan': 'Cyan',
        'color.green': 'Green',
        'color.slate': 'Slate',
      },
    }

    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * The language to read from the local table when the locale service cannot
     * answer — before it activates, or if the page has none at all.
     *
     * The reader's own system language decides, not English by default: a page
     * that never receives a dictionary still belongs to someone reading Chinese,
     * and showing them English is indistinguishable from a bug. In the Desktop
     * build this resolves to the Electron process's system language, because the
     * GUI runs inside its embedded Chromium.
     *
     * Resolved once, at module scope: the value cannot change while the page
     * lives, and every render would otherwise re-read it.
     * @returns {'zh' | 'en'} the fallback language.
     */
    const TABLE_LANGUAGE = (() => {
      try {
        const tags = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language ?? '']
        for (const tag of tags) {
          if (typeof tag === 'string' && tag.toLowerCase().split('-')[0] === 'zh') return 'zh'
        }
      } catch {
        // A host without a readable navigator keeps the English table.
      }
      return 'en'
    })()

    /**
     * Look a string up in the active locale, then in this table. The locale
     * service can arrive after the factory runs, so `translate` stays null until
     * `apply` binds it and the table is the fallback.
     */
    let translate = null
    function t(key, params) {
      if (translate !== null) {
        try {
          const value = translate(key, params)
          if (typeof value === 'string' && value !== '') return value
        } catch {
          // A missing key falls through to the local table.
        }
      }
      const fallback = DICT[TABLE_LANGUAGE][key] ?? DICT.en[key] ?? DICT.zh[key]
      return typeof fallback === 'string' ? interpolate(fallback, params) : key
    }

    // ---- the accent palette -----------------------------------------------
    //
    // Every preset is a pair of hex values: the fill used in the light theme and
    // the fill used in the dark theme. Two presets differ between the two on
    // purpose — `amber` is darkened in the light theme and `slate` is lightened
    // in the dark theme — because a single value cannot clear 3:1 against both a
    // white and a near-black page. See the measured table in OPTIMIZATION.md.
    //
    // `ink` is the text colour chosen for the fill: white or near-black, which
    // ever reaches the higher contrast. All nine presets clear 4.5:1.

    const ACCENTS = {
      red: { light: '#dc2626', dark: '#dc2626', ink: 'light', label: 'color.red' },
      orange: { light: '#ea580c', dark: '#ea580c', ink: 'dark', label: 'color.orange' },
      amber: { light: '#ce8509', dark: '#f59e0b', ink: 'dark', label: 'color.amber' },
      rose: { light: '#e11d48', dark: '#e11d48', ink: 'light', label: 'color.rose' },
      violet: { light: '#7c3aed', dark: '#7c3aed', ink: 'light', label: 'color.violet' },
      blue: { light: '#2563eb', dark: '#2563eb', ink: 'light', label: 'color.blue' },
      cyan: { light: '#0891b2', dark: '#0891b2', ink: 'dark', label: 'color.cyan' },
      green: { light: '#16a34a', dark: '#16a34a', ink: 'dark', label: 'color.green' },
      slate: { light: '#374151', dark: '#5b6370', ink: 'light', label: 'color.slate' },
    }

    const ACCENT_ORDER = ['red', 'orange', 'amber', 'rose', 'violet', 'blue', 'cyan', 'green', 'slate']

    /** The text colour for a custom fill: whichever of white/near-black wins. */
    const CUSTOM_INK_LIGHT = '#ffffff'
    const CUSTOM_INK_DARK = '#1a1a1a'

    function hexToRgb(hex) {
      const value = parseInt(hex.slice(1), 16)
      return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
    }

    function channelLuminance(channel) {
      const c = channel / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }

    function relativeLuminance(hex) {
      const [r, g, b] = hexToRgb(hex)
      return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
    }

    function contrastRatio(a, b) {
      const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((left, right) => right - left)
      return (high + 0.05) / (low + 0.05)
    }

    /**
     * Resolve one accent setting into the concrete colours a render needs.
     *
     * A preset answers with its two theme fills. A custom `#rrggbb` answers with
     * the same fill in both themes plus the better text colour, and — when
     * neither white nor near-black clears 4.5:1, the maths that makes pure mid
     * greys unusable — a warning so the panel can steer the user back.
     * @param {string} accent - a preset name or a `#rrggbb` string.
     * @param {boolean} dark - whether the active theme is dark.
     * @returns {{fill: string, ink: string, weak: boolean}} resolved colours.
     */
    function resolveAccent(accent, dark) {
      const preset = ACCENTS[accent]
      if (preset !== undefined) {
        return {
          fill: dark ? preset.dark : preset.light,
          ink: preset.ink === 'light' ? CUSTOM_INK_LIGHT : CUSTOM_INK_DARK,
          weak: false,
        }
      }
      const fill = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : ACCENTS.red.light
      const white = contrastRatio(CUSTOM_INK_LIGHT, fill)
      const black = contrastRatio(CUSTOM_INK_DARK, fill)
      const useWhite = white >= black
      return {
        fill,
        ink: useWhite ? CUSTOM_INK_LIGHT : CUSTOM_INK_DARK,
        weak: Math.max(white, black) < 4.5,
      }
    }

    // ---- the shift model ----------------------------------------------------

    /** What the page uses until the Host answers, and if it never does. */
    const DEFAULTS = {
      startTime: '09:00',
      endTime: '18:00',
      leadMinutes: 15,
      workdays: [1, 2, 3, 4, 5],
      position: 'bottom-right',
      spot: null,
      enabled: true,
      clockedInOn: null,
      dismissedOn: null,
      accentColor: 'red',
      pulseSeconds: 1.8,
      remindWindowMinutes: 240,
    }

    /** The corners the pill may dock to. */
    const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

    const MINUTE_MS = 60_000

    /**
     * The local calendar day of one instant, as `YYYY-MM-DD`.
     *
     * Built from the local parts rather than `toISOString()`, which reports UTC:
     * that would hand a reader in UTC+8 the previous day until 08:00, exactly
     * when a workday reminder has to be right.
     * @param {Date} date - the instant.
     * @returns {string} the local date key.
     */
    function localDateKey(date) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }

    /**
     * The ISO weekday of one instant: Monday 1 through Sunday 7.
     * @param {Date} date - the instant.
     * @returns {number} the ISO weekday.
     */
    function isoWeekday(date) {
      const day = date.getDay()
      return day === 0 ? 7 : day
    }

    /**
     * Turn `HH:MM` into minutes after local midnight.
     * @param {string} time - a validated `HH:MM` string.
     * @returns {number} minutes, 0..1439.
     */
    function minutesOf(time) {
      const [hours, minutes] = time.split(':')
      return Number(hours) * 60 + Number(minutes)
    }

    /**
     * Build the shift anchored to one local calendar day.
     *
     * `startTime >= endTime` means the shift crosses midnight, so its end lands
     * on the following day. This is the whole night-shift story: one interval,
     * one identity (the start day), no separate code path.
     * @param {Date} day - any instant within the start day (only Y/M/D is used).
     * @param {string} startTime - `HH:MM`.
     * @param {string} endTime - `HH:MM`.
     * `key` is the calendar day the shift starts; `print` adds the shift's own
     * shape. The marks (`clockedInOn`, `dismissedOn`) are stored against `print`,
     * not `key`: a mark must describe ONE shift. Against the date alone, changing
     * 09:00-18:00 to 15:00-18:00 and back would carry the old marks onto what is
     * really a different shift, and a dismissal earned by the 15:00 shift would
     * silence the 09:00 one for the rest of the day.
     * @returns {{start: Date, end: Date, key: string, print: string}} the shift.
     */
    function buildShift(day, startTime, endTime) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0)
      start.setMinutes(minutesOf(startTime))
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0)
      end.setMinutes(minutesOf(endTime))
      if (minutesOf(startTime) >= minutesOf(endTime)) end.setDate(end.getDate() + 1)
      const key = localDateKey(start)
      return { start, end, key, print: shiftPrint(key, startTime, endTime) }
    }

    /**
     * The identity of one shift: its start day plus its shape.
     * @param {string} key - the shift-start calendar day.
     * @param {string} startTime - `HH:MM`.
     * @param {string} endTime - `HH:MM`.
     * @returns {string} the mark to store, e.g. `2026-11-05|09:00|18:00`.
     */
    function shiftPrint(key, startTime, endTime) {
      return `${key}|${startTime}|${endTime}`
    }

    /** The shape `shiftPrint` writes; the only mark format this Client reads. */
    const PRINT_SHAPE = /^\d{4}-\d{2}-\d{2}\|([01]\d|2[0-3]):[0-5]\d\|([01]\d|2[0-3]):[0-5]\d$/

    /**
     * Whether a value is a mark this Client can match against a shift.
     * @param {unknown} value - the candidate.
     * @returns {boolean} true for a full shift print.
     */
    function isPrint(value) {
      return typeof value === 'string' && PRINT_SHAPE.test(value)
    }

    /**
     * Whether a stored mark belongs to one shift.
     *
     * Exact match on the full print, nothing else.
     *
     * The bare-date form was once accepted as "any shift that starts that day",
     * for compatibility with marks written before the shape was stored. That
     * rule was a mistake, and it is worth being explicit about why, because the
     * tempting version of it will be proposed again:
     *
     *   - It reinstates the very bug the print exists to fix. A mark on
     *     `2026-11-05` matches the 09:00 shift AND the 15:00 shift, so one
     *     dismissal silences the other for the rest of the day.
     *   - It never expires on its own. Any install that keeps such a mark on
     *     disk stays ambiguous for as long as that date is "today", and nothing
     *     in the UI can explain why the pill is quiet.
     *
     * So an old mark is simply not this shift's mark. The cost is one repeat
     * clock-in, on the upgrade day, for a user who was mid-shift; the failure it
     * prevents is a silently missing clock-out reminder. For a reminder whose
     * whole purpose is that one alert, asking once too often is the cheaper way
     * to be wrong.
     *
     * `host.js` still ACCEPTS the bare-date form on write. That is not
     * compatibility for its own sake: `readState()` falls back to the defaults
     * when validation throws, so rejecting it there would wipe every setting of
     * a user whose file still holds one. Accepting and ignoring is the only
     * branch that neither loses settings nor resurrects the bug.
     * @param {string | null} mark - the stored value.
     * @param {object} shift - the shift to test.
     * @returns {boolean} true when the mark names this shift.
     */
    function markMatches(mark, shift) {
      if (typeof mark !== 'string' || mark === '') return false
      return mark === shift.print
    }

    /**
     * Whether a shift's start day is one of the configured reminder days.
     * @param {object} shift - the shift.
     * @param {number[]} workdays - configured ISO weekdays.
     * @returns {boolean} true when this shift runs.
     */
    function isScheduledShift(shift, workdays) {
      return workdays.includes(isoWeekday(shift.start))
    }

    /**
     * The next shift that will actually run, at or after one instant.
     *
     * This is what an idle pill has to show. "Today at 09:00" is wrong the
     * moment the day's shift is over — at 18:30 the next start is tomorrow's —
     * and wrong all weekend, where it announces a shift that will never run.
     * Only searching the calendar forward gives a time that is true.
     *
     * The search is bounded at eight days, a full week plus today: any
     * non-empty `workdays` must produce a hit inside that window, so the bound
     * only stops a pathological schedule from looping.
     * @param {object} schedule - the settings document.
     * @param {Date} now - the current instant.
     * @returns {object | null} the next shift, or null when none runs at all.
     */
    function nextShiftAfter(schedule, now) {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      for (let offset = 0; offset <= 8; offset += 1) {
        const day = new Date(today)
        day.setDate(day.getDate() + offset)
        const shift = buildShift(day, schedule.startTime, schedule.endTime)
        if (!isScheduledShift(shift, schedule.workdays)) continue
        if (shift.start > now) return shift
      }
      return null
    }

    /**
     * How many calendar days separate two instants, counting local midnights.
     *
     * Not `(b - a) / 86400000`: that divides real elapsed time, so a DST change
     * between the two days yields 0.96 and floors to the wrong day.
     * @param {Date} from - the earlier instant.
     * @param {Date} to - the later instant.
     * @returns {number} whole days from `from` to `to`.
     */
    function dayGap(from, to) {
      const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
      const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
      return Math.round((b - a) / (24 * 60 * MINUTE_MS))
    }

    /**
     * The idle card: outside a shift, but still on screen saying something true.
     *
     * The plugin used to render nothing here, which was wrong in a way a user
     * reported immediately: an absent widget does not read as "you are off the
     * clock", it reads as "this plugin is broken". A dimmed pill naming the next
     * shift says the same thing without the doubt.
     * @param {object} schedule - the settings document.
     * @param {Date} now - the current instant.
     * @returns {object} an `idle` phase carrying the next shift.
     */
    function idleFor(schedule, now) {
      return { phase: 'idle', shift: nextShiftAfter(schedule, now), remaining: 0 }
    }

    /**
     * The schedule's current phase for one instant.
     *
     * Pure, so the ticking pill, the settings panel and the tests read one
     * implementation. It looks at a few days of shifts so a night shift that
     * began yesterday is still found while it runs today, and so the `due` phase
     * can be recognised after its shift has ended.
     * @param {object} schedule - the settings document.
     * @param {Date} now - the current instant.
     * @returns {object} the phase, the shift it belongs to, and label inputs.
     */
    function derivePhase(schedule, now) {
      if (!schedule.enabled) return { phase: 'hidden', shift: null, remaining: 0 }

      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      const shifts = []
      // Yesterday covers a night shift still running this morning; today covers
      // the ordinary case; tomorrow is not needed.
      for (const offset of [-2, -1, 0]) {
        const day = new Date(today)
        day.setDate(day.getDate() + offset)
        const shift = buildShift(day, schedule.startTime, schedule.endTime)
        if (isScheduledShift(shift, schedule.workdays)) shifts.push(shift)
      }

      // 1) A shift is running right now.
      const active = shifts.find((shift) => now >= shift.start && now < shift.end)
      if (active !== undefined) {
        // Dismissing silences the reminder, it does not make the widget vanish:
        // an absent pill reads as a broken plugin, so fall through to the idle
        // card that says when the next shift starts.
        if (markMatches(schedule.dismissedOn, active)) return idleFor(schedule, now)
        if (!markMatches(schedule.clockedInOn, active)) {
          return { phase: 'waiting', shift: active, remaining: active.end - now }
        }
        const remaining = active.end - now
        const leadMs = schedule.leadMinutes * MINUTE_MS
        if (remaining <= leadMs) return { phase: 'soon', shift: active, remaining }
        return { phase: 'working', shift: active, remaining }
      }

      // 2) A shift has ended and its reminder window is still open. "Due" never
      //    depends on the clock-in mark: forgetting to clock in must not cost
      //    the user the one reminder the plugin exists for.
      const windowMs = schedule.remindWindowMinutes * MINUTE_MS
      const ended = shifts
        .filter((shift) => now >= shift.end && now - shift.end < windowMs)
        .sort((left, right) => right.end - left.end)[0]
      if (ended !== undefined) {
        if (markMatches(schedule.dismissedOn, ended)) return idleFor(schedule, now)
        return { phase: 'due', shift: ended, remaining: now - ended.end }
      }

      // Outside every shift: the pill still has something true to say — when the
      // next shift starts. This is an idle state, not an absent one.
      return idleFor(schedule, now)
    }

    /**
     * Whether editing the shift's times has left today's clock-in stranded.
     *
     * A mark is `date|start|end`, so moving either time makes it a different
     * shift and the old mark stops matching — the user has to clock in again.
     * That is deliberate (see `markMatches`), but it is invisible: the form
     * writes, nothing errors, and the pill quietly reverts to 「打卡」. This is
     * what lets the page say so at the moment it happens.
     *
     * "Stranded" is deliberately narrow:
     *
     *   - The mark has to name the SAME day as the shift in view. A mark from an
     *     earlier day is the ordinary start of a new working day, not a loss, and
     *     warning there would fire every single morning.
     *   - The shift must not be over. Changing the times at 19:00 after an 18:00
     *     finish strands the mark too, but there is nothing left to clock into,
     *     so saying "clock in again today" would be false advice.
     *   - A shift that has not started yet still counts: at 10:00, moving the
     *     shift to 14:00 strands the mark just as surely, and the user would
     *     otherwise only discover it at 14:00.
     * @param {object} schedule - the settings document.
     * @param {Date} now - the current instant.
     * @returns {boolean} true when a same-day clock-in no longer applies.
     */
    function clockInLostByEdit(schedule, now) {
      if (schedule.clockedInOn === null) return false
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      const shifts = []
      // Yesterday covers a night shift still running this morning; today covers
      // both a shift in progress and one that has yet to start.
      for (const offset of [-1, 0]) {
        const day = new Date(today)
        day.setDate(day.getDate() + offset)
        const shift = buildShift(day, schedule.startTime, schedule.endTime)
        if (isScheduledShift(shift, schedule.workdays)) shifts.push(shift)
      }
      const running = shifts.find((shift) => now >= shift.start && now < shift.end)
      const later = shifts.find((shift) => shift.key === localDateKey(today) && shift.start > now)
      const current = running ?? later
      if (current === undefined || now >= current.end) return false
      if (markMatches(schedule.clockedInOn, current)) return false
      // The date a print belongs to is its first field; a bare-date mark left by
      // an older version has been dropped to null long before this runs.
      return schedule.clockedInOn.split('|')[0] === current.key
    }

    /**
     * The pill's compact countdown: `05:42` under an hour, `2:05` above it.
     * @param {number} milliseconds - remaining time.
     * @returns {string} the formatted time.
     */
    function formatDelta(milliseconds) {
      const total = Math.max(0, Math.floor(Math.abs(milliseconds) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      // A bare `M:SS` is ambiguous next to a schedule: `10:00` reads as ten
      // o'clock as easily as ten minutes, so units say which one it is.
      //
      // Precision follows what the reader can act on: hours and minutes most of
      // the day, then minutes and seconds inside the last hour — where the
      // seconds are the whole point of a countdown. Showing seconds all day
      // would only make the text twitch every second for no benefit.
      if (hours > 0) return t('delta.hm', { h: hours, m: String(minutes).padStart(2, '0') })
      if (minutes > 0) return t('delta.ms', { m: minutes, s: String(seconds).padStart(2, '0') })
      return t('delta.s', { s: seconds })
    }

    /**
     * The two text lines one phase shows.
     *
     * Two lines, not one, because a single line put two clock-shaped numbers side
     * by side — `18:00 8:12` — and a reader had to work out which was the
     * schedule and which was the countdown. The top line states a fact ("ends at
     * 18:00", "nearly done"), the bottom line is the one live number, always
     * introduced by 「还有」 so it can only mean remaining time.
     *
     * `waiting` carries no countdown on purpose: the shift end is not what is
     * being counted down before the clock-in happens, and a number there read as
     * if the day had already started. Its top line puts the time first
     * (`09:00 上班`) to match the `working` line (`18:00 下班`) directly below it
     * in the same day — and because 「上班打卡 · 09:00」 next to a 「打卡」 button
     * said 打卡 twice in 40px.
     * `idle` names the NEXT shift rather than today's start time. At 18:30 the
     * next start is tomorrow's, and on a Saturday it is Monday's — printing a
     * bare `09:00 上班` there would promise a shift that never runs. The day is
     * therefore stated relative to `now`, which is why this needs the instant
     * and the shift rather than only the schedule.
     * @param {string} phase - the phase name.
     * @param {object} schedule - the settings document.
     * @param {number} remaining - milliseconds until the shift ends.
     * @param {object | null} shift - the shift this phase belongs to.
     * @param {Date} now - the current instant.
     * @returns {{primary: string, secondary: string}} the lines to draw.
     */
    function labelsFor(phase, schedule, remaining, shift, now) {
      if (phase === 'idle') {
        if (shift === null || shift === undefined) return { primary: t('pill.idle.none'), secondary: '' }
        const start = schedule.startTime
        const gap = dayGap(now, shift.start)
        if (gap === 0) return { primary: t('pill.idle.today', { start }), secondary: '' }
        if (gap === 1) return { primary: t('pill.idle.tomorrow', { start }), secondary: '' }
        const weekday = isoWeekday(shift.start)
        return { primary: t('pill.idle.weekday', { day: t(`week.${weekday}`), start }), secondary: '' }
      }
      if (phase === 'waiting') {
        return { primary: t('pill.waiting', { start: schedule.startTime }), secondary: '' }
      }
      if (phase === 'working') {
        return {
          primary: t('pill.endAt', { time: schedule.endTime }),
          secondary: t('pill.remaining', { delta: formatDelta(remaining) }),
        }
      }
      if (phase === 'soon') {
        return {
          primary: t('pill.soon', { time: schedule.endTime }),
          secondary: t('pill.remaining', { delta: formatDelta(remaining) }),
        }
      }
      if (phase === 'due') return { primary: t('pill.due'), secondary: '' }
      return { primary: '', secondary: '' }
    }

    // ---- talking to the Host half -------------------------------------------

    /**
     * Read one response's JSON, refusing anything that is not an `ok` payload.
     * @param {Response} response - the fetched response.
     * @returns {Promise<object>} the body.
     * @throws {Error} carrying the Host's own message.
     */
    async function readPayload(response) {
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.message ?? `HTTP ${response.status}`)
      }
      return body
    }

    /**
     * The whole client-side store: one snapshot the pill and the panel share.
     *
     * They are separate slot entries, so a save in the panel has to reach the
     * pill without either reaching into the other's DOM. `useSyncExternalStore`
     * gives React the subscription, and the snapshot object is replaced only on
     * a real change so the store cannot spin.
     */
    const listeners = new Set()
    let snapshot = { status: 'loading', state: DEFAULTS, error: null }

    function publish(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function getSnapshot() {
      return snapshot
    }

    /**
     * Normalize whatever the Host returned into a complete document, so a
     * render can never read `undefined.workdays.includes`. The Host validates
     * already; this is the page's guard against a newer or older Host.
     * @param {object} raw - the Host's document.
     * @returns {object} a complete document.
     */
    function adaptState(raw) {
      const merged = { ...DEFAULTS, ...(raw ?? {}) }
      const time = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback)
      const startTime = time(merged.startTime, DEFAULTS.startTime)
      const endTime = time(merged.endTime, DEFAULTS.endTime)
      return {
        // A stored pair that has collapsed to a zero-length shift falls back as
        // a pair, never as one half of the old one.
        startTime: startTime === endTime ? DEFAULTS.startTime : startTime,
        endTime: startTime === endTime ? DEFAULTS.endTime : endTime,
        leadMinutes: Number.isInteger(merged.leadMinutes) ? merged.leadMinutes : DEFAULTS.leadMinutes,
        workdays:
          Array.isArray(merged.workdays) && merged.workdays.length > 0
            ? merged.workdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
            : DEFAULTS.workdays,
        position: CORNERS.includes(merged.position) ? merged.position : DEFAULTS.position,
        spot: adaptSpot(merged.spot),
        enabled: merged.enabled !== false,
        // Only the full print is carried into the store. A bare-date mark left by
        // an older version is dropped here, once: nothing downstream can match
        // it, so keeping it would leave `dismissedThisShift` reporting a
        // dismissal that no shift owns.
        clockedInOn: isPrint(merged.clockedInOn) ? merged.clockedInOn : null,
        dismissedOn: isPrint(merged.dismissedOn) ? merged.dismissedOn : null,
        accentColor:
          typeof merged.accentColor === 'string' && (ACCENTS[merged.accentColor] !== undefined || /^#[0-9a-fA-F]{6}$/.test(merged.accentColor))
            ? merged.accentColor
            : DEFAULTS.accentColor,
        pulseSeconds: [1.2, 1.8, 3].includes(merged.pulseSeconds) ? merged.pulseSeconds : DEFAULTS.pulseSeconds,
        remindWindowMinutes:
          Number.isInteger(merged.remindWindowMinutes) && merged.remindWindowMinutes >= 15
            ? merged.remindWindowMinutes
            : DEFAULTS.remindWindowMinutes,
      }
    }

    /**
     * Normalize a stored free-drag position.
     *
     * Anything that is not a usable pair of fractions becomes `null`, which means
     * "use the corner preset" — a half-written or older document then lands in a
     * known place instead of at an unspecified one.
     * @param {unknown} value - the stored value.
     * @returns {{x: number, y: number} | null} the usable spot.
     */
    function adaptSpot(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
      const { x, y } = value
      const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
      if (!usable(x) || !usable(y)) return null
      // `(0,0)`, the exact top-left, is a real place to park the pill and is
      // kept. It used to be rejected as "no saved position": back when the
      // overlay layer was measured with `getBoundingClientRect()` on the slot's
      // `display:contents` wrapper, that call returned all zeros, so EVERY drag
      // reported (0,0) and storing it stranded the pill in the corner. Those
      // measurements now come from `offsetParent` (see `measureFrame`) and a
      // drag refuses to start at all while the frame is unmeasurable, so the
      // value can only come from a gesture that genuinely ended there. Treating
      // it as absent meant dragging to that corner was silently undone.
      return { x, y }
    }

    /** Read the stored schedule once; a failure leaves the defaults on screen. */
    function loadOnce() {
      if (snapshot.status !== 'loading') return
      fetch(STATE_PATH, { cache: 'no-store' })
        .then(readPayload)
        .then((body) => publish({ status: 'ready', state: adaptState(body.state), error: null }))
        .catch((error) => publish({ status: 'failed', state: snapshot.state, error: messageOf(error) }))
    }

    /** Try the Host again after a failed read, keeping the current state meanwhile. */
    function reload() {
      publish({ status: 'loading', state: snapshot.state, error: null })
      fetch(STATE_PATH, { cache: 'no-store' })
        .then(readPayload)
        .then((body) => publish({ status: 'ready', state: adaptState(body.state), error: null }))
        .catch((error) => publish({ status: 'failed', state: snapshot.state, error: messageOf(error) }))
    }

    /**
     * Apply a patch optimistically, then confirm it with the Host.
     *
     * The pill answers the moment a control changes; a refused write rolls the
     * store back to what was there before, so the panel cannot drift from what
     * is actually stored.
     * @param {object} patch - the fields to change.
     * @returns {Promise<void>} resolution after the Host answers.
     */
    async function commit(patch) {
      const previous = snapshot.state
      const optimistic = adaptState({ ...previous, ...patch })
      publish({ status: 'saving', state: optimistic, error: null })
      try {
        const response = await fetch(STATE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = await readPayload(response)
        publish({ status: 'ready', state: adaptState(body.state), error: null })
      } catch (error) {
        publish({ status: 'failed', state: previous, error: messageOf(error) })
        throw error
      }
    }

    /**
     * Read one error's text.
     * @param {unknown} error - the caught value.
     * @returns {string} its message.
     */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // ---- geometry -----------------------------------------------------------
    //
    // Two ways to place the pill, and the panel follows whichever is in use:
    //
    //   corner preset — anchored to one side pair with a fixed 16px inset. Simple,
    //                   and what a fresh install starts with.
    //   free spot     — a stored fraction of the pill's TRAVEL RANGE, i.e. of
    //                   (window - pill). That range is what makes the fraction
    //                   survive a resize: 1 always means "flush against the edge",
    //                   so a pill parked bottom-right stays bottom-right when the
    //                   window shrinks, where a pixel offset would fall outside.

    /**
     * Corner presets, written as COMPLETE declarations.
     *
     * Every axis is stated — the unused one as `auto` — because React does not
     * clear an inline style property that a later render stops mentioning. Going
     * from a dragged position (`left`/`top`) back to a corner would otherwise
     * keep the old `left`/`top` beside the new `right`/`bottom`, and the browser
     * would honour whichever it resolved first.
     */
    const CORNER_STYLE = {
      'bottom-right': { bottom: 16, right: 16, left: 'auto', top: 'auto' },
      'bottom-left': { bottom: 16, left: 16, right: 'auto', top: 'auto' },
      'top-right': { top: 16, right: 16, left: 'auto', bottom: 'auto' },
      'top-left': { top: 16, left: 16, right: 'auto', bottom: 'auto' },
    }

    /** The pill's height, so the panel can clear it. */
    const PILL_HEIGHT = 48

    /** How close two positions must be, in px, before a press counts as a drag. */
    const DRAG_THRESHOLD = 3

    /** The four inline properties a drag writes directly and a re-render must own. */
    const OFFSET_PROPERTIES = ['left', 'top', 'right', 'bottom']

    /**
     * Put the pill's inline offsets back under React's control.
     *
     * `onPointerMove` writes `element.style` imperatively, because following the
     * pointer through a state update per frame would re-render the whole pill
     * (and the countdown text in it) sixty times a second. React only touches a
     * style it believes changed, so the next render's `style` object can be
     * identical to the previous one — which is exactly the case when a drag ends
     * and the stored position does not change — and React then writes nothing.
     * The imperative values would stay in the DOM while the state says otherwise:
     * that divergence is how the pill could sit at the top-left with the panel
     * opening at the configured bottom-left corner.
     *
     * Writing the declarations again is not enough on its own: React's style
     * diff compares against the values it rendered last, not against the DOM, so
     * it would skip them as unchanged. Clearing the four properties first makes
     * the DOM match "nothing rendered" for them, and the caller then re-applies
     * `desired` explicitly. Declarations the pill does not control (the accent
     * custom properties, also on this element) are never touched.
     * @param {HTMLElement | null} element - the pill element.
     * @param {object} desired - the position declarations React renders.
     */
    function reclaimOffsets(element, desired) {
      if (element === null || element === undefined) return
      for (const property of OFFSET_PROPERTIES) element.style[property] = ''
      for (const property of OFFSET_PROPERTIES) {
        const value = desired[property]
        if (value !== undefined) element.style[property] = typeof value === 'number' ? `${value}px` : String(value)
      }
    }

    /**
     * Turn a stored fraction into a pixel offset inside a frame of `frame` size.
     *
     * The fraction maps onto the travel range, then the result is clamped so the
     * pill stays fully visible even after the window shrank far below the size it
     * was parked in.
     * @param {{x: number, y: number}} spot - fractions, 0..1 on each axis.
     * @param {{width: number, height: number}} frame - the overlay layer's size.
     * @param {{width: number, height: number}} size - the pill's own size.
     * @returns {{left: number, top: number}} pixel offset from the frame's origin.
     */
    function spotToPixels(spot, frame, size) {
      const maxX = Math.max(0, frame.width - size.width)
      const maxY = Math.max(0, frame.height - size.height)
      const clamp = (value, max) => Math.min(Math.max(value, 0), max)
      return { left: clamp(spot.x * maxX, maxX), top: clamp(spot.y * maxY, maxY), right: 'auto', bottom: 'auto' }
    }

    /**
     * Turn a pixel offset back into the stored fraction.
     * @param {{left: number, top: number}} pixels - offset from the frame origin.
     * @param {{width: number, height: number}} frame - the overlay layer's size.
     * @param {{width: number, height: number}} size - the pill's own size.
     * @returns {{x: number, y: number}} fractions, 0..1 on each axis.
     */
    function pixelsToSpot(pixels, frame, size) {
      const maxX = Math.max(1, frame.width - size.width)
      const maxY = Math.max(1, frame.height - size.height)
      return {
        x: Math.min(1, Math.max(0, pixels.left / maxX)),
        y: Math.min(1, Math.max(0, pixels.top / maxY)),
      }
    }

    /**
     * The panel's inline anchor.
     *
     * For a corner the panel sits on the same side as the pill, cleared by the
     * pill's height so opening it never hides what was just clicked. For a free
     * spot it is placed under (or above, near the bottom edge) the pill's saved
     * position, kept inside the frame.
     * @param {object} schedule - the settings document.
     * @param {{width: number, height: number}} frame - the overlay layer's size.
     * @param {number} panelHeight - the panel's estimated height in px.
     * @returns {object} inline offsets for the panel.
     */
    function panelAnchorFor(schedule, frame, panelHeight = 0) {
      if (schedule.spot !== null && frame.width > 0) {
        const pixels = spotToPixels(schedule.spot, frame, { width: 320, height: PILL_HEIGHT })
        const GAP = 8
        const EDGE = 8
        // Vertical: pick the side with more room, then clamp BOTH ends.
        //
        // A corner preset anchors `bottom`, so the panel grows UPWARD into the
        // frame and the CSS `max-height` alone keeps it inside. A dragged spot
        // anchors `top`, so the panel grows DOWNWARD: past the middle of the
        // window there is no longer enough room for a full-height form, and
        // `max-height` does not help — it caps the height but the element still
        // hangs off the bottom edge, which is what pushed the whole page scroll
        // height out and looked like the panel "stretching the window".
        //
        // `panelHeight` is the measured height (0 before the first layout), and
        // the fallback deliberately matches what the CSS actually allows rather
        // than a smaller guess: the old 420 against a 600px cap is why the flip
        // decision believed there was room that was not there.
        const height = panelHeight > 0 ? panelHeight : Math.min(600, frame.height * 0.76)
        const belowTop = pixels.top + PILL_HEIGHT + GAP
        const aboveTop = pixels.top - height - GAP
        const roomBelow = frame.height - EDGE - belowTop
        const roomAbove = pixels.top - GAP - EDGE
        let top
        if (roomBelow >= height) top = belowTop
        else if (roomAbove >= height) top = aboveTop
        else top = roomBelow >= roomAbove ? belowTop : aboveTop
        // Whichever side won, the panel may still be taller than the space it
        // chose; keep it inside the frame so it never enlarges the page.
        const maxTop = Math.max(EDGE, frame.height - height - EDGE)
        top = Math.min(Math.max(top, EDGE), maxTop)
        const left = Math.min(Math.max(EDGE, pixels.left), Math.max(EDGE, frame.width - 348))
        return { top, left }
      }
      const base = CORNER_STYLE[schedule.position] ?? CORNER_STYLE['bottom-right']
      // `!== undefined` is the wrong test here: every corner states BOTH axes and
      // writes the unused one as the string 'auto' (see CORNER_STYLE), so the key
      // always exists. Testing presence picked `bottom` for a top corner and then
      // computed `'auto' + 48 + 8`, which concatenates to the invalid value
      // "auto488" — the declaration is dropped, the panel gets no vertical anchor
      // at all and lands over the pill it was opened from. Only a number means
      // "this axis is the anchored one".
      const vertical = typeof base.bottom === 'number'
        ? { bottom: base.bottom + PILL_HEIGHT + 8 }
        : { top: base.top + PILL_HEIGHT + 8 }
      const horizontal = typeof base.right === 'number'
        ? { right: base.right }
        : { left: base.left }
      return { ...vertical, ...horizontal }
    }

    /**
     * Measure the overlay layer the pill is rendered into.
     *
     * The slot's own container is the frame-wide layer, so its box is the space
     * the pill may occupy. Falls back to the window when the parent cannot be
     * measured (a detached render in a test, for instance).
     * @param {HTMLElement | null} element - the pill element.
     * @returns {{width: number, height: number}} the frame size.
     */
    function measureFrame(element) {
      if (element === null || element === undefined) return { width: 0, height: 0, left: 0, top: 0 }
      // The slot machinery wraps every entry in a `display:contents` anchor, which
      // has NO layout box: `getBoundingClientRect()` on it is all zeros. Walking up
      // to the offsetParent finds the layer that actually positions the pill
      // (the frame-wide overlay), and its origin is what event coordinates are
      // relative to. Falling back to the viewport here would silently place the
      // pill relative to the wrong box.
      const anchor = element.offsetParent ?? element.parentElement
      if (anchor === null || anchor === undefined) return { width: 0, height: 0, left: 0, top: 0 }
      const rect = anchor.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
      }
      return { width: 0, height: 0, left: 0, top: 0 }
    }

    // ---- the pill -----------------------------------------------------------

    /**
     * The floating pill, or nothing at all when it has nothing to say.
     *
     * Every clickable part is a real `<button>`: it must be reachable and
     * operable from the keyboard. The changing text is outside a live region —
     * otherwise a screen reader would read the countdown once a second. Only the
     * phase label lives in one, so a phase change is announced once.
     * @returns {object} the pill element.
     */
    function Pill() {
      const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [now, setNow] = useState(() => new Date())
      const [panelOpen, setPanelOpen] = useState(false)
      const [shaking, setShaking] = useState(false)
      const schedule = store.state

      // One tick a second drives both the countdown text and the phase, so no
      // separate timer has to decide "due". The panel is memoized below so this
      // re-render never reaches an open form.
      useEffect(() => {
        const handle = setInterval(() => setNow(new Date()), 1000)
        return () => clearInterval(handle)
      }, [])

      // Read the stored schedule once the Client half is live.
      useEffect(() => {
        loadOnce()
      }, [])

      // The theme decides which fill of a preset is used, so the pill has to
      // re-render when the user switches light/dark.
      const theme = useSyncExternalStore(
        (listener) => ctxThemeSubscribe(listener),
        () => ctxThemeSnapshot(),
        () => ctxThemeSnapshot(),
      )
      const dark = theme?.dark === true

      const derived = useMemo(() => derivePhase(schedule, now), [schedule, now])
      const phase = derived.phase
      const accent = useMemo(() => resolveAccent(schedule.accentColor, dark), [schedule.accentColor, dark])
      const labels = useMemo(
        () => labelsFor(phase, schedule, derived.remaining, derived.shift, now),
        [phase, schedule, derived.remaining, derived.shift, now],
      )

      // The transition into "due" gets one shake burst on top of the steady
      // breathing: an arrival is what the eye must catch.
      const previousPhase = useRef(phase)
      useEffect(() => {
        if (phase === 'due' && previousPhase.current !== 'due') {
          setShaking(true)
          const handle = setTimeout(() => setShaking(false), 900)
          previousPhase.current = phase
          return () => clearTimeout(handle)
        }
        previousPhase.current = phase
        return undefined
      }, [phase])

      // ---- position: corner preset or free drag ----------------------------
      //
      // The frame is measured after mount and again on resize; a stored spot is
      // a fraction of the pill's travel range, so only the frame size is needed
      // to turn it back into pixels.
      const rootRef = useRef(null)
      const [frame, setFrame] = useState({ width: 0, height: 0, left: 0, top: 0 })
      useEffect(() => {
        const measure = () => setFrame(measureFrame(rootRef.current))
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      // The pill's own size decides the travel range, so it is measured rather
      // than assumed: a hardcoded width would let a saved `x: 1` sit short of the
      // right edge (or push past it) whenever the label grew.
      const [size, setSize] = useState({ width: 0, height: PILL_HEIGHT })
      useEffect(() => {
        const element = rootRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        setSize((previous) =>
          Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
            ? previous
            : { width: rect.width, height: rect.height },
        )
      })

      const position = useMemo(() => {
        // Until both the layer and the pill are measured, a saved spot cannot be
        // converted; showing the corner preset for that one frame avoids a flash
        // at the top-left corner.
        if (schedule.spot !== null && frame.width > 0 && size.width > 0) {
          return spotToPixels(schedule.spot, frame, size)
        }
        return CORNER_STYLE[schedule.position] ?? CORNER_STYLE['bottom-right']
      }, [schedule.spot, schedule.position, frame, size])

      const closePanel = useCallback(() => setPanelOpen(false), [])
      const openPanel = useCallback(() => setPanelOpen(true), [])

      /**
       * Drag the pill anywhere in the frame.
       *
       * Pointer capture keeps the events coming while the pointer leaves the
       * pill, and a movement threshold separates a drag from a click so a press
       * that is meant to open the panel still opens it. The position is written
       * back only on release: committing per frame would flood the Host with
       * writes for a gesture nobody has finished.
       */
      const dragRef = useRef(null)
      const [dragging, setDragging] = useState(false)

      // Re-assert React's ownership of the inline offsets after every render
      // that can change them. While a gesture is live the pointer handler owns
      // `left`/`top` (following the pointer through state would re-render the
      // pill and its ticking text every frame), and React will not overwrite
      // them later by itself: its style diff compares the previous render's
      // values, which are unchanged when a drop lands where the state already
      // pointed. Running before paint means the reclaim never shows.
      //
      // Placed after `dragging` is declared: a hook's dependency array is read
      // during render, so naming it earlier would hit the temporal dead zone.
      useLayoutEffect(() => {
        const element = rootRef.current
        if (element === null || dragging) return
        reclaimOffsets(element, position)
      }, [position, dragging])

      const onPointerDown = useCallback(
        (event) => {
          if (event.button !== 0) return
          const element = rootRef.current
          if (element === null) return
          const frame = measureFrame(element)
          // No measurable positioning layer means the pill's own coordinates are
          // unknown; refusing to start is better than dropping it at (0,0).
          if (frame.width === 0 || frame.height === 0) return
          const own = element.getBoundingClientRect()
          const bounds = { width: frame.width, height: frame.height, left: frame.left, top: frame.top }
          dragRef.current = {
            pointerId: event.pointerId,
            element,
            originX: event.clientX,
            originY: event.clientY,
            startLeft: own.left - bounds.left,
            startTop: own.top - bounds.top,
            moved: false,
            bounds,
            size: { width: own.width, height: own.height },
          }
          // Pointer capture is NOT taken here on purpose. Capturing on press
          // retargets every later event — including the click — to the pill, so a
          // plain tap would stop opening the panel. It is taken on the first
          // move that clears the threshold, once the gesture is known to be a
          // drag rather than a click.
        },
        [],
      )

      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const dx = event.clientX - drag.originX
        const dy = event.clientY - drag.originY
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        if (!drag.moved) {
          drag.moved = true
          setDragging(true)
          // Now that this is a drag, keep the events coming even when the
          // pointer leaves the pill's box.
          try {
            drag.element.setPointerCapture(drag.pointerId)
          } catch {
            // A pointer that already ended cannot be captured; the drag simply
            // stops following, which the release path already handles.
          }
        }
        // Follow the pointer directly; the stored fraction is recomputed on
        // release from wherever it was dropped.
        const left = Math.min(Math.max(drag.startLeft + dx, 0), Math.max(0, drag.bounds.width - drag.size.width))
        const top = Math.min(Math.max(drag.startTop + dy, 0), Math.max(0, drag.bounds.height - drag.size.height))
        if (drag.element !== null) {
          drag.element.style.left = `${left}px`
          drag.element.style.top = `${top}px`
          drag.element.style.right = 'auto'
          drag.element.style.bottom = 'auto'
        }
      }, [])

      const endDrag = useCallback(
        (event) => {
          const drag = dragRef.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          dragRef.current = null
          if (drag.element !== null && drag.element.hasPointerCapture(event.pointerId)) {
            drag.element.releasePointerCapture(event.pointerId)
          }
          if (!drag.moved) {
            // A press that never moved is a click; the button's own handler runs.
            return
          }
          setDragging(false)
          // Snapshot the drop position BEFORE anything reclaims the offsets: the
          // element still holds the dragged offset, which is the truth to store.
          const own = drag.element.getBoundingClientRect()
          const pixels = { left: own.left - drag.bounds.left, top: own.top - drag.bounds.top }
          // Only `spot` is written. Sending `position` alongside it would make
          // the Host clear the spot as a corner preset — the drag would vanish.
          //
          // `drag.bounds`, not a bare `bounds`: that name only ever existed in
          // onPointerDown's own scope, so reading it here threw a ReferenceError
          // before the write — every drag silently discarded itself.
          //
          // The imperative offsets left behind here are reclaimed by the layout
          // effect below, on the render this state change schedules. That render
          // already carries the new spot (the optimistic publish happens in the
          // same synchronous run), so the pill is reclaimed straight to where it
          // was dropped — no flash back to the old corner in between.
          commit({ spot: pixelsToSpot(pixels, { width: drag.bounds.width, height: drag.bounds.height }, drag.size) }).catch(() => {})
        },
        [],
      )

      const clockIn = useCallback(() => {
        const current = derivePhase(snapshot.state, new Date())
        if (current.shift !== null) commit({ clockedInOn: current.shift.print }).catch(() => {})
      }, [])

      const acknowledge = useCallback(() => {
        const current = derivePhase(snapshot.state, new Date())
        if (current.shift !== null) commit({ dismissedOn: current.shift.print }).catch(() => {})
      }, [])

      // The accent drives the card through a CSS custom property rather than
      // inline rules on every child, so one style object recolours the whole
      // component and the breathing animation can read the same value.
      const accentStyle = {
        '--dsh-offwork-accent': accent.fill,
        '--dsh-offwork-ink': accent.ink,
        '--dsh-offwork-pulse': `${schedule.pulseSeconds}s`,
      }

      // Only an explicit opt-out removes the pill. Every other reason the pill
      // used to disappear — before the shift, after it, a rest day, a dismissed
      // reminder — now renders as the dimmed `idle` card instead: a widget that
      // vanishes reads as a broken plugin, not as "you are off the clock".
      const collapsed = phase === 'hidden'
      const pillClass = [
        'dsh-offwork-pill',
        `dsh-offwork-${phase}`,
        shaking ? 'dsh-offwork-shake' : '',
      ]
        .filter(Boolean)
        .join(' ')

      return h(
        React.Fragment,
        null,
        h(Styles),
        // Only the phase's statement is announced, never the ticking number.
        h('span', { className: 'dsh-offwork-srOnly', role: 'status' }, labels.primary),
        collapsed
          ? h('span', { className: 'dsh-offwork-ghost', ref: rootRef })
          : h(
              'div',
              {
                className: dragging ? `${pillClass} dsh-offwork-grabbing` : pillClass,
                style: { ...position, ...accentStyle },
                ref: rootRef,
                onPointerDown,
                onPointerMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
              },
              h(
                'div',
                { className: 'dsh-offwork-main' },
                h('span', { className: 'dsh-offwork-dot', 'aria-hidden': true }),
                h(
                  'button',
                  { type: 'button', className: 'dsh-offwork-copy', onClick: openPanel, title: t('open') },
                  h('span', { className: 'dsh-offwork-line' }, labels.primary),
                  // The live number gets its own line so it never reads as a
                  // second clock time beside the schedule.
                  labels.secondary === ''
                    ? null
                    : h('span', { className: 'dsh-offwork-clock' }, labels.secondary),
                ),
              ),
              // The one action this phase offers. `waiting` invites the daily
              // clock-in; `due` acknowledges the reminder. Both are the same
              // shape so the pill never jumps between sizes.
              phase === 'waiting'
                ? h('button', { type: 'button', className: 'dsh-offwork-action', onClick: clockIn }, t('act.clockIn'))
                : null,
              phase === 'due'
                ? h('button', { type: 'button', className: 'dsh-offwork-action', onClick: acknowledge }, t('act.known'))
                : null,
              phase === 'due' || phase === 'waiting'
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-offwork-gear',
                      onClick: openPanel,
                      title: t('open'),
                      'aria-label': t('open'),
                    },
                    '⚙',
                  ),
            ),
        panelOpen ? h(MemoSettingsPanel, { onClose: closePanel, frame }) : null,
      )
    }

    // ---- theme (optional service) -------------------------------------------
    //
    // The theme service is optional: a page without it still renders, using the
    // light fills. It is read through the module-level bridge below so the pill
    // can subscribe without threading the context through React.

    let themeService = null

    /**
     * Cached theme snapshots.
     *
     * `useSyncExternalStore` compares snapshots with `Object.is` while rendering
     * and again right after subscribing, so `getSnapshot` MUST return the same
     * reference until the value actually changes. Returning a fresh object each
     * call makes React re-render forever and the slot entry ends up blank — that
     * is exactly what a `{ dark: false }` literal here caused once. Two frozen
     * objects, one per scheme, are all this ever needs.
     */
    const THEME_SNAPSHOT_LIGHT = Object.freeze({ dark: false })
    const THEME_SNAPSHOT_DARK = Object.freeze({ dark: true })

    function ctxThemeSnapshot() {
      if (themeService === null) return THEME_SNAPSHOT_LIGHT
      try {
        const value = themeService.getTheme()
        // The presenter switches the palette from `colorScheme`, never from the
        // id: a user theme may call itself anything, so the id says nothing
        // about which fill of an accent preset to use.
        return value?.active?.colorScheme === 'dark' ? THEME_SNAPSHOT_DARK : THEME_SNAPSHOT_LIGHT
      } catch {
        return THEME_SNAPSHOT_LIGHT
      }
    }

    /** The listeners `theme/change` fans out to; empty without a theme service. */
    const themeChangeListeners = new Set()

    function ctxThemeSubscribe(listener) {
      themeChangeListeners.add(listener)
      return () => {
        themeChangeListeners.delete(listener)
      }
    }

    // ---- the settings panel -------------------------------------------------

    /**
     * The settings surface: every control the pill's behaviour has, each write
     * going straight to the Host.
     *
     * A popover, not a modal dialog: it is small, has no destructive action, and
     * anchors to the same corner as the pill. Escape and a click outside close
     * it; focus moves into the card on open.
     * @param {{onClose: () => void}} props - the close callback.
     * @returns {object} the panel element.
     */
/**
     * The settings form itself, shared by its two homes.
     *
     * It is one component because the fields, the validation and the write path
     * must not fork: the popover beside the pill and the section on the plugin's
     * detail page are two shells around this same body, so a setting changed in
     * one place behaves identically in the other.
     * @returns {object} the form content.
     */
    function SettingsForm() {
      const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const schedule = store.state
      const [lastError, setLastError] = useState(null)

      const write = useCallback((patch) => {
        setLastError(null)
        commit(patch).catch((error) => setLastError(messageOf(error)))
      }, [])

      const toggleDay = useCallback(
        (day) => {
          const next = schedule.workdays.includes(day)
            ? schedule.workdays.filter((entry) => entry !== day)
            : [...schedule.workdays, day].sort((left, right) => left - right)
          // The Host refuses an empty set; refusing it here too makes the click
          // a no-op instead of a round trip that rolls the control back.
          if (next.length === 0) {
            setLastError(t('panel.daysRequired'))
            return
          }
          write({ workdays: next })
        },
        [schedule.workdays, write],
      )

      const setTime = useCallback(
        (field, value) => {
          // `<input type="time">` emits '' while a field is half-typed; writing
          // that would store a value the Host refuses.
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return
          const other = field === 'startTime' ? schedule.endTime : schedule.startTime
          if (value === other) {
            setLastError(t('panel.shiftInvalid'))
            return
          }
          write({ [field]: value })
        },
        [schedule.startTime, schedule.endTime, write],
      )

      const showLoadError = store.status === 'failed' && store.error !== null && lastError === null
      const derived = derivePhase(schedule, new Date())
      // A dismissal is never undone by comparing against `derived.shift`: in the
      // `idle` phase that shift is the NEXT one, while `dismissedOn` holds the
      // key of the shift that was dismissed — so the two can never match and the
      // escape hatch disappeared exactly when it was needed. The mark itself is
      // the whole answer.
      const dismissedThisShift = schedule.dismissedOn !== null
      const overnight = minutesOf(schedule.startTime) >= minutesOf(schedule.endTime)
      const customActive = ACCENTS[schedule.accentColor] === undefined
      // Editing either time is what drops the mark, so the warning belongs
      // beside those two fields rather than in a footnote at the bottom. The
      // pill does not run at all while it is switched off, so a stranded mark is
      // moot there and saying so would only be noise.
      const markLost = schedule.enabled
        ? clockInLostByEdit(schedule, new Date())
        : false

      return h(
        React.Fragment,
        null,

          store.status === 'loading' ? h('div', { className: 'dsh-offwork-note' }, t('panel.loading')) : null,
          showLoadError
            ? h(
                'div',
                { className: 'dsh-offwork-note dsh-offwork-bad' },
                t('panel.loadFailed'),
                ' ',
                h('button', { type: 'button', className: 'dsh-offwork-link', onClick: reload }, t('panel.retry')),
              )
            : null,
          lastError !== null
            ? h('div', { className: 'dsh-offwork-note dsh-offwork-bad' }, t('panel.failed', { message: lastError }))
            : null,

          // ---- shift ----
          h('div', { className: 'dsh-offwork-group' }, t('panel.sectionTime')),
          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.startTime')),
            h('input', {
              type: 'time',
              className: 'dsh-offwork-input',
              value: schedule.startTime,
              onChange: (event) => setTime('startTime', event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.endTime')),
            h('input', {
              type: 'time',
              className: 'dsh-offwork-input',
              value: schedule.endTime,
              onChange: (event) => setTime('endTime', event.target.value),
            }),
          ),
          overnight ? h('div', { className: 'dsh-offwork-note' }, t('panel.overnight')) : null,
          // Only when a same-day clock-in was just invalidated. Shown on every
          // edit to these two fields, it would be the same sentence a reader
          // learns to skip; shown at the moment it becomes true, it explains a
          // change the pill is about to make behind their back.
          markLost
            ? h(
                'div',
                { className: 'dsh-offwork-note dsh-offwork-warnShift', role: 'status' },
                t('panel.shiftResetsMark'),
              )
            : null,

          // ---- reminders ----
          h('div', { className: 'dsh-offwork-group' }, t('panel.sectionWarn')),
          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.lead')),
            h(
              'select',
              {
                className: 'dsh-offwork-input',
                value: String(schedule.leadMinutes),
                onChange: (event) => write({ leadMinutes: Number(event.target.value) }),
              },
              [0, 5, 10, 15, 30, 60].map((minutes) =>
                h(
                  'option',
                  { key: minutes, value: String(minutes) },
                  minutes === 0 ? t('panel.leadNone') : t('panel.leadValue', { n: minutes }),
                ),
              ),
            ),
          ),
          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.pulseLabel')),
            h(
              'select',
              {
                className: 'dsh-offwork-input',
                value: String(schedule.pulseSeconds),
                onChange: (event) => write({ pulseSeconds: Number(event.target.value) }),
              },
              [1.2, 1.8, 3].map((seconds) =>
                h(
                  'option',
                  { key: seconds, value: String(seconds) },
                  seconds === 1.2 ? t('panel.pulseFast') : seconds === 1.8 ? t('panel.pulseNormal') : t('panel.pulseSlow'),
                ),
              ),
            ),
          ),
          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.windowLabel')),
            h(
              'select',
              {
                className: 'dsh-offwork-input',
                value: String(schedule.remindWindowMinutes),
                onChange: (event) => write({ remindWindowMinutes: Number(event.target.value) }),
              },
              [60, 120, 240, 480].map((minutes) =>
                h('option', { key: minutes, value: String(minutes) }, t('panel.windowValue', { n: minutes / 60 })),
              ),
            ),
          ),
          h('div', { className: 'dsh-offwork-hint' }, t('panel.windowHint')),

          h(
            'div',
            { className: 'dsh-offwork-field' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.workdays')),
            h(
              'div',
              { className: 'dsh-offwork-days', role: 'group', 'aria-label': t('panel.workdays') },
              [1, 2, 3, 4, 5, 6, 7].map((day) =>
                h(
                  'button',
                  {
                    key: day,
                    type: 'button',
                    className: schedule.workdays.includes(day)
                      ? 'dsh-offwork-day dsh-offwork-dayOn'
                      : 'dsh-offwork-day',
                    'aria-pressed': schedule.workdays.includes(day),
                    'aria-label': t(`day.${day}`),
                    onClick: () => toggleDay(day),
                  },
                  t(`day.${day}`),
                ),
              ),
            ),
          ),

          // ---- appearance ----
          h('div', { className: 'dsh-offwork-group' }, t('panel.sectionLook')),
          h(
            'div',
            { className: 'dsh-offwork-field' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.accent')),
            h(
              'div',
              { className: 'dsh-offwork-swatches', role: 'group', 'aria-label': t('panel.accent') },
              ACCENT_ORDER.map((name) =>
                h('button', {
                  key: name,
                  type: 'button',
                  className:
                    schedule.accentColor === name ? 'dsh-offwork-swatch dsh-offwork-swatchOn' : 'dsh-offwork-swatch',
                  style: { '--dsh-offwork-swatch': ACCENTS[name].light },
                  title: t(ACCENTS[name].label),
                  'aria-label': t(ACCENTS[name].label),
                  'aria-pressed': schedule.accentColor === name,
                  onClick: () => write({ accentColor: name }),
                }),
              ),
              // The fallback the request asked for: any colour at all. The
              // input's value shows the current custom fill, or the red preset's
              // when a preset is active, so the control is never blank.
              h('label', {
                className: customActive ? 'dsh-offwork-swatch dsh-offwork-swatchOn dsh-offwork-swatchCustom' : 'dsh-offwork-swatch dsh-offwork-swatchCustom',
                style: { '--dsh-offwork-swatch': customActive ? schedule.accentColor : ACCENTS.red.light },
                title: t('panel.custom'),
              },
                h('input', {
                  type: 'color',
                  className: 'dsh-offwork-colorInput',
                  value: customActive ? schedule.accentColor : ACCENTS.red.light,
                  'aria-label': t('panel.custom'),
                  onChange: (event) => write({ accentColor: event.target.value }),
                }),
              ),
            ),
          ),

          h(
            'label',
            { className: 'dsh-offwork-row' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.position')),
            h(
              'select',
              {
                className: 'dsh-offwork-input',
                value: schedule.position,
                onChange: (event) => write({ position: event.target.value }),
              },
              CORNERS.map((position) => h('option', { key: position, value: position }, t(`pos.${position}`))),
            ),
          ),
          schedule.spot === null
            ? h('div', { className: 'dsh-offwork-hint' }, t('panel.dragHint'))
            : h(
                'div',
                { className: 'dsh-offwork-hint' },
                t('panel.dragHint'),
                ' ',
                h(
                  'button',
                  { type: 'button', className: 'dsh-offwork-link', onClick: () => write({ spot: null }) },
                  t('panel.resetSpot'),
                ),
              ),

          h(
            'label',
            { className: 'dsh-offwork-row dsh-offwork-switchRow' },
            h('span', { className: 'dsh-offwork-rowLabel' }, t('panel.enabled')),
            h('input', {
              type: 'checkbox',
              className: 'dsh-offwork-check',
              checked: schedule.enabled,
              onChange: (event) => write({ enabled: event.target.checked }),
            }),
          ),


          // The clock-in rule is the one piece of behaviour a reader cannot
          // infer from the controls, so it is stated once.
          h('div', { className: 'dsh-offwork-hint' }, t('panel.clockInHint')),

          // A dismissed shift draws nothing at all, so this is the only way back
          // — and it is reachable from the plugin page, which never depends on
          // the pill being on screen.
          dismissedThisShift
            ? h(
                'div',
                { className: 'dsh-offwork-row' },
                h('span', { className: 'dsh-offwork-rowLabel' }, t('act.known')),
                h(
                  'button',
                  { type: 'button', className: 'dsh-offwork-link', onClick: () => write({ dismissedOn: null }) },
                  t('panel.retry'),
                ),
              )
            : null,

          h('div', { className: 'dsh-offwork-foot' }, t('panel.hint')),
      )
    }

    /**
     * The popover shell: the form anchored beside the pill.
     *
     * A transparent catcher rather than a dim backdrop — this is a popover, and
     * dimming the whole app to change a schedule is heavier than the interaction
     * deserves. It still closes on a click outside.
     * @param {{onClose: () => void, frame: object}} props - close callback and layer size.
     * @returns {object} the popover element.
     */
    function SettingsPanel({ onClose, frame }) {
      const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const cardRef = useRef(null)

      useEffect(() => {
        const card = cardRef.current
        if (card !== null && typeof card.focus === 'function') card.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      // The panel's real height, measured after layout. Two passes on purpose:
      // the first render has no height to constrain against, so it uses the
      // CSS cap as a fallback; once the box exists, `panelAnchorFor` can decide
      // which side of the pill actually fits instead of guessing.
      const [panelHeight, setPanelHeight] = useState(0)
      useLayoutEffect(() => {
        const card = cardRef.current
        if (card === null) return
        const height = card.offsetHeight
        if (height > 0) setPanelHeight((previous) => (Math.abs(previous - height) < 0.5 ? previous : height))
      })

      const anchor = panelAnchorFor(store.state, frame, panelHeight)

      return h(
        React.Fragment,
        null,
        h(Styles),
        h('div', { className: 'dsh-offwork-catcher', onClick: onClose, 'aria-hidden': true }),
        h(
          'div',
          {
            className: 'dsh-offwork-panel',
            style: anchor,
            role: 'dialog',
            'aria-modal': false,
            'aria-label': t('panel.title'),
            tabIndex: -1,
            ref: cardRef,
          },
          h(
            'div',
            { className: 'dsh-offwork-head' },
            h(
              'div',
              { className: 'dsh-offwork-headText' },
              h('div', { className: 'dsh-offwork-title' }, t('panel.title')),
              h('div', { className: 'dsh-offwork-subtitle' }, t('panel.subtitle')),
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-offwork-close', onClick: onClose, 'aria-label': t('panel.close') },
              '✕',
            ),
          ),
          h(SettingsForm),
        ),
      )
    }

    /**
     * The settings of this plugin, on its own page in **Plugins**.
     *
     * Registered into `plugins.bundle.config`, the slot the page keeps for "a
     * bundle's own configuration", NOT into `plugins.detail.section`. The
     * difference is where the reader finds it, and the page's own order is what
     * decides that:
     *
     *   detail document (`meta.detail` or README)  ← the plugin's long
     *   configuration (this form)                     description, which the
     *   component rows                                page draws from the
     *   versions / source                             package's own files
     *
     * `plugins.detail.section` sits at the very BOTTOM of that list, after the
     * README, the component rows, the version list and the install source. A
     * settings form there is a form nobody scrolls to: the page spends the
     * whole viewport on documentation first, and the install facts a reader
     * needs once crowd the same space. `plugins.bundle.config` is dispatched
     * directly under the title and above the README, so the controls are the
     * first thing on the page and the documentation stays below as reference.
     *
     * Registering nothing at all is not an option: the README is drawn by the
     * page itself from the package's files, so it appears whether or not this
     * plugin contributes a section. The only way to put the form above it is
     * the earlier slot.
     *
     * The page asks a `plugins.bundle.config` entry for `view: 'page'` on the
     * bundle's page and `view: 'summary'` where a one-liner is wanted; this
     * plugin has no one-liner to offer, so `summary` renders nothing.
     * @param {{view?: string}} props - the page's requested view.
     * @returns {object | null} the form, or null for the summary view.
     */
    function BundleConfig({ view }) {
      if (view === 'summary') return null
      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'section',
          { className: 'dsh-offwork-section', 'aria-label': t('panel.settingsHead') },
          // A heading that names the thing, not its behaviour. This card sits
          // directly under the page's long description, which is a column of
          // prose ending in a table; a card that opens with a descriptive
          // sentence is read as one more paragraph of it. 「设置」 plus the gear
          // the pill itself uses for this form is what says "controls".
          h(
            'div',
            { className: 'dsh-offwork-sectionHead' },
            h('span', { className: 'dsh-offwork-sectionIcon', 'aria-hidden': true }, '⚙'),
            h(
              'div',
              { className: 'dsh-offwork-sectionText' },
              h('h4', { className: 'dsh-offwork-sectionTitle' }, t('panel.settingsHead')),
              h('p', { className: 'dsh-offwork-sectionHint' }, t('panel.settingsHint')),
            ),
          ),
          h(SettingsForm),
        ),
      )
    }

    /**
     * The panel, memoized.
     *
     * The pill re-renders every second for the countdown; `onClose` is a stable
     * callback, so this wrapper stops that tick from reaching an open form. The
     * comparison is explicit because `frame` is an object rebuilt on each pill
     * render: without it, every tick would remount the form.
     */
    const MemoSettingsPanel = React.memo(
      SettingsPanel,
      (previous, next) =>
        previous.onClose === next.onClose &&
        previous.frame.width === next.frame.width &&
        previous.frame.height === next.frame.height,
    )

    // ---- styles -------------------------------------------------------------
    //
    // Every colour is a theme token or a resolved accent, so the widget follows
    // light/dark and any themed build; only the drop shadows are literal,
    // because they describe depth rather than a palette role.

    function Styles() {
      return h('style', { 'data-dsh-plugin': 'dsh-offwork-countdown' }, CSS)
    }

    const CSS = `
/* ---- the pill ---------------------------------------------------------- */
.dsh-offwork-pill{position:absolute;z-index:30;display:flex;align-items:center;height:48px;max-width:min(420px,calc(100vw - 32px));border-radius:999px;border:2px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 20px rgba(0,0,0,.16);overflow:hidden;pointer-events:auto;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);transition:border-color 220ms ease,box-shadow 220ms ease,background 220ms ease}
.dsh-offwork-main{display:flex;align-items:center;gap:9px;min-width:0;padding:0 12px 0 16px}
.dsh-offwork-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);transition:background 220ms ease}
/* Two stacked lines: a fact on top, the one live number below. Stacking is what
   keeps the schedule time and the countdown from reading as two clock times. */
.dsh-offwork-copy{display:flex;flex-direction:column;justify-content:center;gap:1px;min-width:0;max-width:220px;padding:0;border:0;background:none;font:inherit;color:inherit;text-align:start;cursor:pointer}
.dsh-offwork-copy:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:6px}
.dsh-offwork-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:17px}
.dsh-offwork-clock{font-variant-numeric:tabular-nums;font-size:12px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-offwork-action{flex:none;height:28px;margin:0 6px 0 2px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm, 8px);background:var(--dsw-alias-bg-layer-2);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;transition:background 160ms ease}
.dsh-offwork-action:hover{background:var(--dsw-alias-border-l2)}
.dsh-offwork-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-offwork-gear{flex:none;width:32px;height:32px;margin-right:8px;padding:0;border:0;border-radius:50%;background:none;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-offwork-gear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-offwork-gear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

/* Grab affordances: the pill is draggable, so the cursor says so and a drag in
   progress drops the transition that would otherwise lag behind the pointer. */
.dsh-offwork-pill{cursor:grab;touch-action:none;user-select:none}
.dsh-offwork-grabbing{cursor:grabbing;transition:none;box-shadow:0 10px 30px rgba(0,0,0,.28);z-index:33}
.dsh-offwork-grabbing *{cursor:grabbing}
/* While dragging, buttons inside must not swallow the gesture. */
.dsh-offwork-grabbing .dsh-offwork-copy,.dsh-offwork-grabbing .dsh-offwork-action,.dsh-offwork-grabbing .dsh-offwork-gear{pointer-events:none}

/* A zero-size box that exists only so the frame can be measured while the pill
   is not shown. Being absolutely positioned is what gives it an offsetParent —
   the measurement walks up to the overlay layer from here. */
.dsh-offwork-ghost{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}

/* ---- idle: on screen, but there is nothing to act on --------------------- */
/* Quiet must not mean illegible. Measured: --dsw-alias-label-secondary is
   4.90:1 in light and 3.85:1 in dark against this surface, and any opacity on
   top of that drops it below the 4.5:1 a 13px label needs — at .72 it measured
   2.88:1, which is exactly the fault the old 30px dot had at 1.11:1. So the
   text keeps full opacity and the state is carried by the ABSENT action button,
   the muted dot and the flatter shadow instead of by fading the type.

   Dark mode is the tighter of the two at 3.85:1; label-primary is the fallback
   there so the line still clears the threshold in both themes. */
.dsh-offwork-idle{box-shadow:0 4px 14px rgba(0,0,0,.10)}
.dsh-offwork-idle .dsh-offwork-line{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:400}
.dsh-offwork-idle .dsh-offwork-dot{background:var(--dsw-alias-label-secondary)}
/* It is still draggable and still opens the settings, so the cursor keeps saying
   so; only the border and the dot are muted. */

/* ---- waiting: the shift started, today's clock-in is not marked ---------- */
.dsh-offwork-waiting{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-offwork-waiting .dsh-offwork-line{font-size:14px;line-height:20px}
.dsh-offwork-waiting .dsh-offwork-dot{background:var(--dsw-alias-state-warn-primary)}
.dsh-offwork-waiting .dsh-offwork-action{background:var(--dsw-alias-state-warn-primary);color:#27241f;font-weight:600}
.dsh-offwork-waiting .dsh-offwork-action:hover{filter:brightness(1.06)}

/* ---- soon: the heads-up window, the accent at low strength -------------- */
/* The heads-up state belongs to the same ramp as "due", so it carries the same
   accent — just far weaker: the card takes a 30% tint of it and the countdown
   stays in label-primary. Two reasons it is not the accent as text:
   on the pill surface (bg-overlay) a saturated accent is only 1.02-4.82:1, and
   in the dark theme that surface is the mid grey #61666b, where a raw accent
   drops to ~1.1:1 and simply cannot carry 12px type. Tinting the CARD instead
   keeps the accent visible without putting legible text at risk.
   Mixing into bg-base (not bg-overlay) is what makes one rule serve both
   themes: the tint lands pale on a white page and deep on a near-black one,
   which is the direction each theme needs. */
.dsh-offwork-soon{border-color:var(--dsh-offwork-accent);background:color-mix(in srgb, var(--dsh-offwork-accent) 30%, var(--dsw-alias-bg-base, var(--dsw-alias-bg-overlay, #ffffff)))}
.dsh-offwork-soon .dsh-offwork-dot{background:var(--dsh-offwork-accent)}
.dsh-offwork-soon .dsh-offwork-clock{color:var(--dsw-alias-label-primary);font-weight:600}

/* ---- due: the accent fills the card, and the pill breathes -------------- */
.dsh-offwork-due{border-color:var(--dsh-offwork-accent);background:var(--dsh-offwork-accent);color:var(--dsh-offwork-ink);box-shadow:0 6px 24px color-mix(in srgb, var(--dsh-offwork-accent) 55%, transparent);animation:dsh-offwork-breathe var(--dsh-offwork-pulse, 1.8s) ease-in-out infinite}
.dsh-offwork-due .dsh-offwork-dot{background:var(--dsh-offwork-ink);opacity:.85;animation:dsh-offwork-beat var(--dsh-offwork-pulse, 1.8s) ease-in-out infinite}
.dsh-offwork-due .dsh-offwork-gear{color:var(--dsh-offwork-ink)}
.dsh-offwork-due .dsh-offwork-action{background:color-mix(in srgb, var(--dsh-offwork-ink) 18%, transparent);color:var(--dsh-offwork-ink);font-weight:600}
.dsh-offwork-due .dsh-offwork-action:hover{background:color-mix(in srgb, var(--dsh-offwork-ink) 28%, transparent)}
.dsh-offwork-due .dsh-offwork-gear:hover{background:color-mix(in srgb, var(--dsh-offwork-ink) 18%, transparent)}
.dsh-offwork-due .dsh-offwork-copy:focus-visible,.dsh-offwork-due .dsh-offwork-action:focus-visible,.dsh-offwork-due .dsh-offwork-gear:focus-visible{outline-color:var(--dsh-offwork-ink)}
@keyframes dsh-offwork-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
@keyframes dsh-offwork-beat{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.7);opacity:.35}}
/* the arrival burst: three quick shakes, then the pill settles into breathing.
   The burst belongs to the pill itself — its children are clipped by its own
   rounded, hidden-overflow box, so a shake on a child would be cropped. */
.dsh-offwork-shake{animation:dsh-offwork-shake 220ms ease-in-out 4}
@keyframes dsh-offwork-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@media (prefers-reduced-motion:reduce){.dsh-offwork-due{animation:none}.dsh-offwork-due .dsh-offwork-dot{animation:none}.dsh-offwork-shake{animation:none}}

/* ---- the settings panel ------------------------------------------------- */
/* On the plugin's detail page the form is a card of its own, and it has to
   LOOK like one: bg-layer-1 is #fff in the light theme, the same white the page
   paints, and border-l1 is 4% black — 1.09:1 against that white. A card drawn
   with those two tokens is invisible, so the form read as another paragraph of
   the description above it rather than as a set of controls.
   settings-card-stroke (16% black) and bg-layer-3 are the tokens the shipped
   settings cards use for exactly this, so the box matches theirs. */
.dsh-offwork-section{display:flex;flex-direction:column;gap:10px;margin-top:18px;padding:16px 18px 18px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,#00000029));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}
.dsh-offwork-sectionHead{display:flex;align-items:flex-start;gap:9px;margin-bottom:2px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-offwork-sectionIcon{flex:none;font-size:15px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-offwork-sectionText{min-width:0}
.dsh-offwork-sectionTitle{margin:0;font-size:14px;font-weight:600;line-height:20px}
.dsh-offwork-sectionHint{margin:2px 0 0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}

.dsh-offwork-catcher{position:absolute;inset:0;z-index:31;pointer-events:auto}
/* Visually hidden, still announced: the phase label is the only text a screen
   reader should hear change, never the once-a-second countdown. */
.dsh-offwork-srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-offwork-panel{position:absolute;z-index:32;box-sizing:border-box;width:min(340px,calc(100vw - 32px));max-height:min(76vh,600px);overflow:auto;display:flex;flex-direction:column;gap:9px;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 40px rgba(0,0,0,.26);pointer-events:auto;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}
.dsh-offwork-panel:focus{outline:none}
.dsh-offwork-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dsh-offwork-headText{min-width:0}
.dsh-offwork-title{font-size:14px;font-weight:600}
.dsh-offwork-subtitle{margin-top:3px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-offwork-close{flex:none;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:none;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-offwork-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-offwork-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-offwork-group{margin-top:6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.dsh-offwork-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsh-offwork-field{display:flex;flex-direction:column;gap:6px}
.dsh-offwork-rowLabel{color:var(--dsw-alias-label-secondary)}
.dsh-offwork-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dsh-offwork-input{min-width:132px;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;color-scheme:light dark}
.dsh-offwork-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.dsh-offwork-days{display:flex;gap:4px}
.dsh-offwork-day{flex:1;padding:6px 0;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-offwork-day:hover{border-color:var(--dsw-alias-border-l2)}
.dsh-offwork-day:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-offwork-dayOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}

/* The palette: nine presets then the custom picker, which is a colour input
   disguised as one more swatch so the row reads as one control. */
.dsh-offwork-swatches{display:flex;flex-wrap:wrap;gap:6px}
.dsh-offwork-swatch{position:relative;width:26px;height:26px;padding:0;border:2px solid transparent;border-radius:50%;background:var(--dsh-offwork-swatch);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)}
.dsh-offwork-swatch:hover{transform:scale(1.08)}
.dsh-offwork-swatch:focus-within,.dsh-offwork-swatch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-offwork-swatchOn{border-color:var(--dsw-alias-label-primary)}
.dsh-offwork-swatchCustom{display:grid;place-items:center;background:conic-gradient(from 0deg,#f87171,#fbbf24,#34d399,#38bdf8,#a78bfa,#f87171);cursor:pointer}
.dsh-offwork-colorInput{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;cursor:pointer}

.dsh-offwork-switchRow{cursor:pointer}
.dsh-offwork-check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-offwork-note{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
.dsh-offwork-bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
/* The same amber the pill itself uses for 「快下班了」, so a warning reads the
   same way everywhere in this plugin. Label stays primary: amber-500 is 2.2:1
   against white, which is fine for a fill or a border and far too thin for the
   sentence inside it. */
.dsh-offwork-warnShift{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
.dsh-offwork-link{padding:0;border:0;background:none;font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline}
.dsh-offwork-foot{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
`

    return {
      // `theme` is optional: a page without it still renders, using the light
      // fills, so it is declared for soft ordering rather than hard activation.
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, DICT), 'dsh-offwork-countdown: dictionaries')
          translate = locale.bind(NS)
        }
        const theme = ctx.get('theme')
        if (theme !== undefined && typeof theme.getTheme === 'function') {
          themeService = theme
          ctx.effect(
            () =>
              ctx.on('theme/change', () => {
                for (const listener of [...themeChangeListeners]) listener()
              }),
            'dsh-offwork-countdown: theme changes',
          )
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-offwork-countdown', order: 40, locale: NS }, Pill),
        )
        // The settings live here rather than in `plugins.detail.section`: the
        // page draws its own README above that slot, so a form registered there
        // is only reachable after scrolling past the whole long description.
        // `plugins.bundle.config` is rendered directly under the title, above
        // the README, which is where someone opening this page wants the
        // controls. See `BundleConfig`.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS },
            BundleConfig),
        )
      },
    }
  },
})
