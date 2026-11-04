/* =========================================================================
   SlotSync — app.js
   A shared-resource booking scheduler in plain JavaScript.

   SECTIONS
     1.  Constants
     2.  Helpers (escaping, DOM, formatting)
     3.  Date & time helpers
     4.  Conflict & validation logic  (pure — no DOM, no storage)
     5.  Storage (safe, with try/catch)
     6.  Data (sample data, accessors, mutations)
     7.  Rendering
     8.  Dialogs
     9.  Toasts
    10.  Event handling
    11.  Init

   The rule followed throughout: user-typed text NEVER reaches innerHTML
   without passing through escapeHtml(), or is set with textContent.
   ========================================================================= */

(function () {
  'use strict';

  /* =======================================================================
     1. CONSTANTS
     ======================================================================= */

  /** Minutes in one calendar slot. Everything on the grid is a multiple of this. */
  var SLOT = 30;

  /** The visible grid always runs 08:00 to 20:00, as 30-minute rows. */
  var GRID_OPEN = 8 * 60;    // 480
  var GRID_CLOSE = 20 * 60;  // 1200

  /** How far ahead the "next free slot" search looks, in days. */
  var SEARCH_DAYS = 14;

  /** How long an Undo offer stays on screen, in milliseconds. */
  var UNDO_MS = 6000;

  var STORAGE_KEY = 'slotsync.v1';
  var THEME_KEY = 'slotsync.theme';

  var COLORS = ['teal', 'violet', 'amber', 'rose', 'sky', 'lime'];

  /* =======================================================================
     2. HELPERS — escaping, DOM building, formatting
     ======================================================================= */

  /**
   * Turn any value into text that is safe to drop inside innerHTML.
   * This is the single defence against XSS from names, purposes and
   * resource titles typed by users.
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /** Keep an emoji/short icon safe and short: max 2 code points, no markup. */
  function sanitizeEmoji(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return '📦';
    // Reject anything that smells like markup or a URL.
    if (/[<>&"'/\\]/.test(text)) return '📦';
    return Array.from(text).slice(0, 2).join('');
  }

  /**
   * Small DOM builder so the calendar can be created without innerHTML.
   * props: class, text, html, dataset, style, or any attribute.
   */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    props = props || {};

    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });

    var list = Array.isArray(children) ? children : (children === undefined ? [] : [children]);
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });

    return node;
  }

  function $(selector) { return document.querySelector(selector); }

  /** Round a number to one decimal place, without trailing ".0". */
  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  /** Pluralise a simple English noun: pluralise(1,'booking') -> "1 booking". */
  function pluralise(count, singular, plural) {
    return count + ' ' + (count === 1 ? singular : (plural || singular + 's'));
  }

  /** Human-readable length: 90 -> "1 hour 30 minutes". */
  function formatDuration(minutes) {
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    var parts = [];
    if (hours) parts.push(pluralise(hours, 'hour'));
    if (mins) parts.push(pluralise(mins, 'minute'));
    return parts.length ? parts.join(' ') : '0 minutes';
  }

  /* =======================================================================
     3. DATE & TIME HELPERS

     Dates are kept as plain "YYYY-MM-DD" strings.
     Times are kept as whole minutes from midnight (10:00 -> 600).

     Neither is ever a Date object and neither is ever converted to UTC, so
     timezones and daylight-saving changes cannot corrupt a comparison.
     A Date is built only for display, always from explicit year/month/day
     parts — never from `new Date("2026-11-04")`, which would be parsed as UTC
     and can land on the previous day.
     ======================================================================= */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * 600 -> "10:00". The 24-hour form — the exact inverse of labelToMinutes,
   * so the two together can be round-trip tested across every slot. The app
   * itself displays the 12-hour form everywhere; see minutesToLabel12.
   */
  function minutesToLabel(minutes) {
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return pad2(h) + ':' + pad2(m);
  }

  /**
   * 600 -> "10:00 AM", 780 -> "1:00 PM", 720 -> "12:00 PM", 0 -> "12:00 AM".

   * This is what the user actually reads: the calendar, the time dropdowns and
   * every message on the page. Midnight and noon are the two awkward cases —
   * 0 minutes and 720 minutes both show "12", with AM and PM respectively.
   */
  function minutesToLabel12(minutes) {
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    var period = h < 12 ? 'AM' : 'PM';
    var hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return hour12 + ':' + pad2(m) + ' ' + period;
  }

  /**
   * A booking range in 12-hour form: "10:00 AM – 11:00 AM".
   * The meridiem is dropped from the first time when both ends share it, so the
   * common case reads "10:00 – 11:00 AM" rather than repeating "AM" twice.
   */
  function formatRange12(startMin, endMin) {
    var startLabel = minutesToLabel12(startMin);
    var endLabel = minutesToLabel12(endMin);
    if (startLabel.slice(-2) === endLabel.slice(-2)) {
      return startLabel.slice(0, -3) + ' – ' + endLabel;
    }
    return startLabel + ' – ' + endLabel;
  }

  /** "10:30" -> 630. Returns null if the text is not a valid 24h time. */
  function labelToMinutes(label) {
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(label || '').trim());
    if (!match) return null;
    var h = Number(match[1]);
    var m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  /** A Date at 12:00 local on the given key. Noon dodges DST clock changes. */
  function keyToDate(key) {
    var parts = String(key).split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0, 0);
  }

  /** A Date -> "YYYY-MM-DD" using local calendar parts. */
  function dateToKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function isValidKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return false;
    var date = keyToDate(key);
    return dateToKey(date) === key;
  }

  function todayKey() { return dateToKey(new Date()); }

  /** Add (or subtract) whole days to a key, safely across DST boundaries. */
  function addDays(key, days) {
    var date = keyToDate(key);
    date.setDate(date.getDate() + days);
    return dateToKey(date);
  }

  /** 0 = Monday ... 6 = Sunday. */
  function weekdayIndex(key) {
    return (keyToDate(key).getDay() + 6) % 7;
  }

  /** The Monday of the week containing `key`. */
  function startOfWeek(key) {
    return addDays(key, -weekdayIndex(key));
  }

  /** "Mon" */
  var DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  /** "Monday" */
  var DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dayShort(key) { return DAY_SHORT[weekdayIndex(key)]; }
  function dayLong(key) { return DAY_LONG[weekdayIndex(key)]; }

  function dayNumber(key) { return keyToDate(key).getDate(); }
  function monthShort(key) { return MONTH_SHORT[keyToDate(key).getMonth()]; }

  /** "Monday 4 Nov" — used in messages. */
  function formatLongDate(key) {
    return dayLong(key) + ' ' + dayNumber(key) + ' ' + monthShort(key);
  }

  /** "Mon 4 Nov" — used in compact lists. */
  function formatShortDate(key) {
    return dayShort(key) + ' ' + dayNumber(key) + ' ' + monthShort(key);
  }

  /** "Mon 4 Nov, 10:00–11:00" */
  function formatRange(key, startMin, endMin) {
    return formatShortDate(key) + ', ' + formatRange12(startMin, endMin);
  }

  /** Relative day words for the current week: "Today", "Tomorrow", otherwise the date. */
  function formatRelativeDate(key) {
    var today = todayKey();
    if (key === today) return 'Today';
    if (key === addDays(today, 1)) return 'Tomorrow';
    if (key === addDays(today, -1)) return 'Yesterday';
    return formatShortDate(key);
  }

  /** The current wall-clock time as minutes from midnight. */
  function nowMinutes() {
    var now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  /* =======================================================================
     4. CONFLICT & VALIDATION LOGIC
        Pure functions: no DOM, no storage, no hidden state.
        `now` is always passed in so results are reproducible in tests.
     ======================================================================= */

  function durationMinutes(startMin, endMin) {
    return endMin - startMin;
  }

  /**
   * The heart of SlotSync.

   * A booking occupies the half-open interval [start, end) — it owns its
   * start minute but not its end minute. Two intervals overlap when
   *   aStart < bEnd  AND  bStart < aEnd
   * Both comparisons are strict, which is exactly why back-to-back bookings
   * are legal: 10:00–11:00 and 11:00–12:00 give 600 < 660 (true) but
   * 660 < 600 (false) on the other side, so they do not clash.
   */
  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * The first booking on the same resource and date that clashes with the
   * proposed window, or null. `ignoreId` lets a booking be edited without
   * clashing with itself.
   */
  function findOverlap(bookings, candidate) {
    for (var i = 0; i < bookings.length; i++) {
      var b = bookings[i];
      if (b.resourceId !== candidate.resourceId) continue;
      if (b.date !== candidate.date) continue;
      if (candidate.ignoreId && b.id === candidate.ignoreId) continue;
      if (intervalsOverlap(candidate.start, candidate.end, b.start, b.end)) return b;
    }
    return null;
  }

  /** Every booking overlapping a window, sorted by start time. */
  function findAllOverlaps(bookings, candidate) {
    return bookings.filter(function (b) {
      if (b.resourceId !== candidate.resourceId) return false;
      if (b.date !== candidate.date) return false;
      if (candidate.ignoreId && b.id === candidate.ignoreId) return false;
      return intervalsOverlap(candidate.start, candidate.end, b.start, b.end);
    }).sort(function (a, b) { return a.start - b.start; });
  }

  /** A window that has already finished cannot be booked. */
  function isPastWindow(dateKey, startMin, now) {
    if (dateKey < now.todayKey) return true;
    if (dateKey > now.todayKey) return false;
    return startMin < now.nowMin;
  }

  /**
   * Validate a proposed booking and return everything the UI needs.

   * Returns:
   *   { valid, errors: {name,purpose,date,time}, conflict, conflicts, message }
   * `errors` keys map directly onto the fields in the dialog.
   */
  function validateBooking(input, resource, bookings, now) {
    var errors = {};
    var name = String(input.name || '').trim();
    var purpose = String(input.purpose || '').trim();
    var dateKey = String(input.date || '');
    var startMin = input.start;
    var endMin = input.end;

    /* -- the form itself ------------------------------------------------- */
    if (!name) {
      errors.name = 'Please enter your name so others know who booked this.';
    } else if (name.length < 2) {
      errors.name = 'That looks too short — please enter at least 2 characters.';
    }

    if (!purpose) {
      errors.purpose = 'Please say what the slot is for, e.g. "Physics practical".';
    } else if (purpose.length < 2) {
      errors.purpose = 'Please describe the purpose in at least 2 characters.';
    }

    if (!dateKey) {
      errors.date = 'Please choose a date.';
    } else if (!isValidKey(dateKey)) {
      errors.date = 'That date is not a real date. Please pick one from the calendar.';
    }

    if (!resource) {
      return { valid: false, errors: errors, conflict: null, conflicts: [], message: 'Choose a resource first.' };
    }

    /* -- times ----------------------------------------------------------- */
    var timesOk = true;
    if (startMin === null || startMin === undefined || endMin === null || endMin === undefined) {
      errors.time = 'Please choose both a start and an end time.';
      timesOk = false;
    } else if (endMin <= startMin) {
      errors.time = 'The end time must be after the start time.';
      timesOk = false;
    } else if (startMin < resource.open || endMin > resource.close) {
      errors.time = resource.name + ' is only open between ' +
        minutesToLabel12(resource.open) + ' and ' + minutesToLabel12(resource.close) + '.';
      timesOk = false;
    } else if ((endMin - startMin) % SLOT !== 0 || startMin % SLOT !== 0) {
      errors.time = 'Bookings must start and end on a ' + SLOT + '-minute mark.';
      timesOk = false;
    } else if (durationMinutes(startMin, endMin) > resource.maxMinutes) {
      errors.time = 'That is ' + formatDuration(endMin - startMin) + '. ' + resource.name +
        ' allows a maximum of ' + formatDuration(resource.maxMinutes) + ' per booking.';
      timesOk = false;
    }

    /* -- the past -------------------------------------------------------- */
    if (!errors.date && dateKey && timesOk) {
      if (isPastWindow(dateKey, startMin, now)) {
        errors.date = dateKey < now.todayKey
          ? 'That date is in the past. Please pick today or a later date.'
          : 'That time has already passed today. Please pick a later slot.';
      }
    } else if (!errors.date && dateKey && dateKey < now.todayKey) {
      errors.date = 'That date is in the past. Please pick today or a later date.';
    }

    /* -- conflicts ------------------------------------------------------- */
    var conflict = null;
    var conflicts = [];
    if (!errors.date && !errors.time && dateKey && timesOk) {
      conflicts = findAllOverlaps(bookings, {
        resourceId: resource.id,
        date: dateKey,
        start: startMin,
        end: endMin,
        ignoreId: input.ignoreId
      });
      conflict = conflicts.length ? conflicts[0] : null;
    }

    var valid = Object.keys(errors).length === 0 && !conflict;

    return {
      valid: valid,
      errors: errors,
      conflict: conflict,
      conflicts: conflicts,
      message: conflict
        ? 'Overlaps with ' + conflict.name + "'s booking, " +
          minutesToLabel12(conflict.start) + ' to ' + minutesToLabel12(conflict.end) + '.'
        : ''
    };
  }

  /**
   * The nearest free windows for the same resource and duration.

   * Every 30-minute start on the day is ranked by distance from the requested
   * start, ties going to the earlier time, and the first `limit` that are
   * actually free are returned. If the day has nothing, the next two days are
   * searched in the same way so the user always gets a usable suggestion.
   */
  function findSuggestions(resource, bookings, dateKey, startMin, duration, limit, ignoreId) {
    if (!resource || !duration || duration <= 0) return [];
    limit = limit || 3;

    var results = [];
    var dayKeys = [dateKey, addDays(dateKey, 1), addDays(dateKey, 2)];

    for (var d = 0; d < dayKeys.length && results.length < limit; d++) {
      var day = dayKeys[d];
      var candidates = [];

      for (var s = resource.open; s + duration <= resource.close; s += SLOT) {
        if (d === 0 && s === startMin) continue;   // that is the slot that just failed
        candidates.push(s);
      }

      candidates.sort(function (a, b) {
        var da = Math.abs(a - startMin);
        var db = Math.abs(b - startMin);
        return da === db ? a - b : da - db;
      });

      for (var i = 0; i < candidates.length && results.length < limit; i++) {
        var start = candidates[i];
        var clash = findOverlap(bookings, {
          resourceId: resource.id,
          date: day,
          start: start,
          end: start + duration,
          ignoreId: ignoreId
        });
        if (!clash) {
          results.push({ date: day, start: start, end: start + duration });
        }
      }
    }

    return results;
  }

  /** Minutes inside opening hours that are taken up on one day. */
  function bookedMinutesForDay(bookings, resource, dateKey) {
    var open = resource.open;
    var close = resource.close;
    var total = 0;
    bookings.forEach(function (b) {
      if (b.resourceId !== resource.id || b.date !== dateKey) return;
      var start = Math.max(b.start, open);
      var end = Math.min(b.end, close);
      if (end > start) total += end - start;
    });
    return total;
  }

  /** Percentage of opening hours booked across the given week (0–100). */
  function weekBusyPercent(bookings, resource, weekStartKey) {
    var capacity = (resource.close - resource.open) * 7;
    if (capacity <= 0) return 0;
    var used = 0;
    for (var i = 0; i < 7; i++) {
      used += bookedMinutesForDay(bookings, resource, addDays(weekStartKey, i));
    }
    return Math.min(100, round1((used / capacity) * 100));
  }

  /**
   * The earliest free window of at least `duration` for a resource,
   * searching forward from `fromKey`/`fromMin`.
   */
  function findNextFreeSlot(bookings, resource, fromKey, fromMin, duration) {
    duration = duration || SLOT;
    for (var d = 0; d < SEARCH_DAYS; d++) {
      var day = addDays(fromKey, d);
      for (var s = resource.open; s + duration <= resource.close; s += SLOT) {
        if (d === 0 && s < fromMin) continue;
        var clash = findOverlap(bookings, {
          resourceId: resource.id, date: day, start: s, end: s + duration
        });
        if (!clash) return { date: day, start: s, end: s + duration };
      }
    }
    return null;
  }

  /* =======================================================================
     5. STORAGE
        Every access is wrapped in try/catch. If storage is blocked (private
        window, locked-down browser, quota full) the app keeps running on an
        in-memory copy and simply forgets on refresh.
     ======================================================================= */

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Read and repair the saved state. Anything that does not look like a
   * resource or a booking is dropped rather than trusted — a corrupted
   * storage entry must never break the page.
   */
  function loadState() {
    var raw = safeGet(STORAGE_KEY);
    if (!raw) return null;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    var resources = Array.isArray(parsed.resources)
      ? parsed.resources.map(normaliseResource).filter(Boolean)
      : [];
    var bookings = Array.isArray(parsed.bookings)
      ? parsed.bookings.map(normaliseBooking).filter(Boolean)
      : [];

    // Drop bookings whose resource no longer exists.
    var ids = resources.map(function (r) { return r.id; });
    bookings = bookings.filter(function (b) { return ids.indexOf(b.resourceId) !== -1; });

    if (!resources.length) return null;
    return { resources: resources, bookings: bookings };
  }

  function normaliseResource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = String(raw.name || '').trim().slice(0, 40);
    if (!name) return null;

    var open = Number(raw.open);
    var close = Number(raw.close);
    if (!isFinite(open) || !isFinite(close) || close <= open) {
      open = GRID_OPEN;
      close = GRID_CLOSE;
    }

    var max = Number(raw.maxMinutes);

    return {
      id: String(raw.id || makeId('res')),
      name: name,
      emoji: sanitizeEmoji(raw.emoji),
      color: COLORS.indexOf(raw.color) !== -1 ? raw.color : 'teal',
      maxMinutes: isFinite(max) && max >= SLOT ? max : 120,
      open: Math.max(GRID_OPEN, open),
      close: Math.min(GRID_CLOSE, close)
    };
  }

  function normaliseBooking(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = String(raw.name || '').trim().slice(0, 40);
    var purpose = String(raw.purpose || '').trim().slice(0, 80);
    var date = String(raw.date || '');
    var start = Number(raw.start);
    var end = Number(raw.end);

    if (!name || !purpose) return null;
    if (!isValidKey(date)) return null;
    if (!isFinite(start) || !isFinite(end)) return null;
    if (start % SLOT !== 0 || end % SLOT !== 0) return null;
    if (end <= start) return null;
    if (start < GRID_OPEN || end > GRID_CLOSE) return null;

    return {
      id: String(raw.id || makeId('bk')),
      resourceId: String(raw.resourceId || ''),
      name: name,
      purpose: purpose,
      date: date,
      start: start,
      end: end,
      createdAt: Number(raw.createdAt) || Date.now()
    };
  }

  function saveState() {
    var ok = safeSet(STORAGE_KEY, JSON.stringify({
      version: 1,
      resources: state.resources,
      bookings: state.bookings
    }));
    if (!ok) warnStorageBlocked();
    return ok;
  }

  function readTheme() {
    var stored = safeGet(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  }

  function writeTheme(theme) {
    safeSet(THEME_KEY, theme);
  }

  /* =======================================================================
     6. DATA
     ======================================================================= */

  var state = { resources: [], bookings: [] };

  var idCounter = 0;
  function makeId(prefix) {
    idCounter += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + idCounter.toString(36);
  }

  /**
   * Sample data is generated relative to the current week, so the demo always
   * shows something in the week you are actually looking at.
   */
  function buildSampleState() {
    var monday = startOfWeek(todayKey());

    var resources = [
      { id: 'res_microscope', name: 'Lab Microscope', emoji: '🔬', color: 'teal',
        maxMinutes: 120, open: 8 * 60, close: 20 * 60 },
      { id: 'res_studyroom', name: 'Study Room B', emoji: '📚', color: 'violet',
        maxMinutes: 180, open: 8 * 60, close: 20 * 60 },
      { id: 'res_washer', name: 'Hostel Washing Machine', emoji: '🧺', color: 'sky',
        maxMinutes: 90, open: 8 * 60, close: 20 * 60 },
      { id: 'res_court', name: 'Sports Court', emoji: '🏀', color: 'lime',
        maxMinutes: 120, open: 9 * 60, close: 18 * 60 }
    ];

    // day: 0 = Monday of the current week, time given as "HH:MM".
    var seeds = [
      { resourceId: 'res_microscope', day: 0, from: '09:00', to: '11:00',
        name: 'Ali', purpose: 'Biology practical' },
      { resourceId: 'res_microscope', day: 1, from: '10:00', to: '11:00',
        name: 'Priya', purpose: 'Water sample analysis' },
      { resourceId: 'res_microscope', day: 1, from: '11:00', to: '12:00',
        name: 'Sam', purpose: 'Slide preparation' },
      { resourceId: 'res_microscope', day: 3, from: '14:00', to: '16:00',
        name: 'Mei', purpose: 'Final year project' },

      { resourceId: 'res_studyroom', day: 0, from: '13:00', to: '15:00',
        name: 'Sam', purpose: 'Group revision' },
      { resourceId: 'res_studyroom', day: 2, from: '09:30', to: '12:30',
        name: 'Priya', purpose: 'Thesis writing' },
      { resourceId: 'res_studyroom', day: 4, from: '16:00', to: '18:00',
        name: 'Ali', purpose: 'Mock interview practice' },

      { resourceId: 'res_washer', day: 0, from: '08:00', to: '09:30',
        name: 'Jonas', purpose: 'Weekly laundry' },
      { resourceId: 'res_washer', day: 2, from: '17:00', to: '18:30',
        name: 'Mei', purpose: 'Bedding wash' },
      { resourceId: 'res_washer', day: 5, from: '10:00', to: '11:30',
        name: 'Ali', purpose: 'Laundry' },

      { resourceId: 'res_court', day: 1, from: '16:00', to: '18:00',
        name: 'Jonas', purpose: 'Basketball practice' },
      { resourceId: 'res_court', day: 3, from: '09:00', to: '10:00',
        name: 'Sam', purpose: 'Badminton' },
      { resourceId: 'res_court', day: 6, from: '10:00', to: '12:00',
        name: 'Priya', purpose: 'Inter-hostel match' }
    ];

    var bookings = seeds.map(function (seed) {
      return {
        id: makeId('bk'),
        resourceId: seed.resourceId,
        name: seed.name,
        purpose: seed.purpose,
        date: addDays(monday, seed.day),
        start: labelToMinutes(seed.from),
        end: labelToMinutes(seed.to),
        createdAt: Date.now()
      };
    }).filter(function (b) { return isValidKey(b.date) && b.start !== null && b.end !== null; });

    // Keep the demo honest: never ship sample bookings that clash.
    var clean = [];
    bookings.forEach(function (b) {
      if (!findOverlap(clean, {
        resourceId: b.resourceId, date: b.date, start: b.start, end: b.end
      })) clean.push(b);
    });

    return { resources: resources, bookings: clean };
  }

  function getResource(id) {
    for (var i = 0; i < state.resources.length; i++) {
      if (state.resources[i].id === id) return state.resources[i];
    }
    return null;
  }

  function getBooking(id) {
    for (var i = 0; i < state.bookings.length; i++) {
      if (state.bookings[i].id === id) return state.bookings[i];
    }
    return null;
  }

  function bookingsFor(resourceId, dateKey) {
    return state.bookings
      .filter(function (b) { return b.resourceId === resourceId && b.date === dateKey; })
      .sort(function (a, b) { return a.start - b.start; });
  }

  function weekBookings(resourceId, weekStartKey) {
    var last = addDays(weekStartKey, 6);
    return state.bookings.filter(function (b) {
      return b.resourceId === resourceId && b.date >= weekStartKey && b.date <= last;
    }).sort(function (a, b) {
      return a.date === b.date ? a.start - b.start : (a.date < b.date ? -1 : 1);
    });
  }

  /** Upcoming (not yet finished) bookings for one person, matched loosely. */
  function upcomingForName(name, now) {
    var needle = String(name || '').trim().toLowerCase();
    if (!needle) return [];
    return state.bookings.filter(function (b) {
      if (b.name.toLowerCase() !== needle) return false;
      if (b.date > now.todayKey) return true;
      if (b.date < now.todayKey) return false;
      return b.end > now.nowMin;
    }).sort(function (a, b) {
      return a.date === b.date ? a.start - b.start : (a.date < b.date ? -1 : 1);
    });
  }

  /** Every name in use, for the datalist suggestion on the name input. */
  function allNames() {
    var seen = {};
    state.bookings.forEach(function (b) { seen[b.name] = true; });
    return Object.keys(seen).sort();
  }

  /* =======================================================================
     7. RENDERING
     ======================================================================= */

  var ui = {
    resourceList: $('#resourceList'),
    resourceEmpty: $('#resourceEmpty'),
    calGrid: $('#calGrid'),
    calSubtitle: $('#calSubtitle'),
    insightList: $('#insightList'),
    insightSub: $('#insightSub'),
    heroStats: $('#heroStats'),
    myBookingsResult: $('#myBookingsResult'),
    toastHost: $('#toastHost')
  };

  /** The Monday of the week currently on screen, as a date key. */
  var viewWeekStart = startOfWeek(todayKey());

  /** Which resource the calendar is showing. */
  var selectedResourceId = null;

  function currentNow() {
    return { todayKey: todayKey(), nowMin: nowMinutes() };
  }

  /* -- resources --------------------------------------------------------- */

  function renderResources() {
    ui.resourceList.textContent = '';
    ui.resourceEmpty.hidden = state.resources.length > 0;

    state.resources.forEach(function (resource) {
      var next = findNextFreeSlot(state.bookings, resource, todayKey(), nowMinutes(), SLOT);
      var busy = weekBusyPercent(state.bookings, resource, viewWeekStart);

      // The card is a plain container holding TWO real buttons: one to select
      // the resource, one to delete it. Nesting the delete control inside the
      // select button would be invalid HTML and unreachable by keyboard.
      var isSelected = resource.id === selectedResourceId;
      var card = el('li', {
        class: 'hue-' + resource.color + ' resource-card' + (isSelected ? ' is-selected' : '')
      }, [
        el('button', {
          type: 'button',
          class: 'res-main',
          'data-resource-id': resource.id,
          'aria-pressed': isSelected ? 'true' : 'false',
          'aria-label': 'Show the week for ' + resource.name
        }, [
          el('span', { class: 'res-top' }, [
            el('span', { class: 'res-emoji', 'aria-hidden': 'true', text: resource.emoji }),
            el('span', { class: 'res-name', text: resource.name })
          ]),
          el('span', { class: 'res-meta' }, [
            el('span', {}, [el('b', { text: formatRange12(resource.open, resource.close) }), ' open']),
            el('span', {}, ['max ', el('b', { text: formatDuration(resource.maxMinutes) })])
          ]),
          el('span', {
            class: 'res-bar',
            role: 'img',
            'aria-label': busy + ' percent of this week is booked'
          }, [
            el('span', { style: { width: Math.max(busy, busy > 0 ? 4 : 0) + '%' } })
          ])
        ]),
        el('div', { class: 'res-actions' }, [
          el('span', {
            class: 'res-next',
            text: next
              ? 'Next free: ' + formatRelativeDate(next.date) + ' ' + minutesToLabel12(next.start)
              : 'No free slots in the next ' + SEARCH_DAYS + ' days'
          }),
          el('button', {
            type: 'button',
            class: 'res-delete',
            'data-delete-resource': resource.id,
            'aria-label': 'Delete resource ' + resource.name,
            text: 'Delete'
          })
        ])
      ]);

      ui.resourceList.appendChild(card);
    });
  }

  /* -- hero stats -------------------------------------------------------- */

  function renderHeroStats() {
    var weekBookingsCount = 0;
    var totalUsed = 0;
    var totalCapacity = 0;

    state.resources.forEach(function (resource) {
      weekBookingsCount += weekBookings(resource.id, viewWeekStart).length;
      totalCapacity += (resource.close - resource.open) * 7;
      for (var i = 0; i < 7; i++) {
        totalUsed += bookedMinutesForDay(state.bookings, resource, addDays(viewWeekStart, i));
      }
    });

    var percent = totalCapacity ? Math.min(100, round1((totalUsed / totalCapacity) * 100)) : 0;

    ui.heroStats.textContent = '';

    [
      { num: state.resources.length, label: 'shared resources' },
      { num: weekBookingsCount, label: 'bookings this week' },
      { num: percent + '%', label: 'of open hours taken' }
    ].forEach(function (stat) {
      ui.heroStats.appendChild(el('li', {}, [
        el('span', { class: 'stat-num', text: String(stat.num) }),
        el('span', { class: 'stat-label', text: stat.label })
      ]));
    });
  }

  /* -- calendar ---------------------------------------------------------- */

  function renderCalendar() {
    var resource = getResource(selectedResourceId);

    if (!resource) {
      ui.calSubtitle.textContent = 'Choose a resource above.';
      ui.calGrid.textContent = '';
      ui.calGrid.appendChild(el('p', {
        class: 'empty-note',
        style: { gridColumn: '1 / -1', margin: 'var(--sp-4)' },
        text: state.resources.length
          ? 'Pick one of the resources above to see its week.'
          : 'Add a resource first, then its week will appear here.'
      }));
      return;
    }

    var now = currentNow();
    var weekEnd = addDays(viewWeekStart, 6);
    var thisWeek = viewWeekStart <= now.todayKey && now.todayKey <= weekEnd;

    ui.calSubtitle.textContent =
      resource.name + ' · ' + formatShortDate(viewWeekStart) + ' – ' + formatShortDate(weekEnd) +
      (thisWeek ? ' · this week' : '') + ' · max ' + formatDuration(resource.maxMinutes) + ' per booking';

    var fragment = document.createDocumentFragment();

    // --- header row -----------------------------------------------------
    fragment.appendChild(el('div', { class: 'cal-corner', 'aria-hidden': 'true' }));

    for (var d = 0; d < 7; d++) {
      var dayKey = addDays(viewWeekStart, d);
      var isToday = dayKey === now.todayKey;
      var isWeekend = d >= 5;

      fragment.appendChild(el('div', {
        class: 'cal-day' + (isToday ? ' is-today' : '') + (isWeekend ? ' is-weekend' : ''),
        'aria-current': isToday ? 'date' : null
      }, [
        el('span', { class: 'cal-day-name', text: dayShort(dayKey) }),
        el('span', { class: 'cal-day-num', text: String(dayNumber(dayKey)) }),
        el('span', { class: 'cal-day-month', text: monthShort(dayKey) }),
        el('span', { class: 'sr-only', text: isToday ? ' (today)' : '' })
      ]));
    }

    // --- time column ----------------------------------------------------
    var timesColumn = el('div', { class: 'cal-times', 'aria-hidden': 'true' });
    for (var t = GRID_OPEN; t < GRID_CLOSE; t += SLOT) {
      var onHour = t % 60 === 0;
      timesColumn.appendChild(el('div', {
        class: 'cal-time' + (onHour ? ' is-hour' : ''),
        text: onHour ? minutesToLabel12(t) : ''
      }));
    }
    fragment.appendChild(timesColumn);

    // --- day columns ----------------------------------------------------
    for (var col = 0; col < 7; col++) {
      fragment.appendChild(buildDayColumn(resource, addDays(viewWeekStart, col), col, now));
    }

    ui.calGrid.textContent = '';
    ui.calGrid.appendChild(fragment);

    // Free slots are tabindex="-1" so a Tab press does not walk through all
    // 168 of them. Exactly one gets a real tab stop, and arrow keys take over
    // from there — the same pattern a spreadsheet grid uses.
    var firstFree = ui.calGrid.querySelector('.cal-slot.is-free');
    if (firstFree) firstFree.setAttribute('tabindex', '0');
  }

  /** One day: its 30-minute cells plus the booking blocks laid over them. */
  function buildDayColumn(resource, dayKey, dayIndex, now) {
    var isToday = dayKey === now.todayKey;
    var isWeekend = dayIndex >= 5;
    var dayBookings = bookingsFor(resource.id, dayKey);

    var column = el('div', {
      class: 'cal-col' + (isToday ? ' is-today' : '') + (isWeekend ? ' is-weekend' : ''),
      'data-day': dayIndex
    });

    for (var slotIndex = 0; slotIndex < (GRID_CLOSE - GRID_OPEN) / SLOT; slotIndex++) {
      var start = GRID_OPEN + slotIndex * SLOT;
      var end = start + SLOT;
      var onHour = start % 60 === 0;

      var closed = start < resource.open || end > resource.close;
      var past = !closed && isPastWindow(dayKey, start, now);
      var covering = closed || past ? null : findOverlap(dayBookings, {
        resourceId: resource.id, date: dayKey, start: start, end: end
      });

      var classes = 'cal-slot' + (onHour ? ' is-hour' : '');

      if (closed) {
        // Outside the resource's opening hours: hatched, plus a written label
        // on the hour rows so the state never depends on colour alone.
        classes += ' is-closed';
        column.appendChild(el('div', {
          class: classes,
          'aria-hidden': 'true',
          title: resource.name + ' is closed at ' + minutesToLabel12(start),
          text: onHour ? 'closed' : ''
        }));
      } else if (past) {
        classes += ' is-past';
        column.appendChild(el('div', {
          class: classes,
          'aria-hidden': 'true',
          title: 'Past slot — no longer bookable',
          text: onHour ? 'past' : ''
        }));
      } else if (covering) {
        classes += ' is-covered';
        column.appendChild(el('div', { class: classes, 'aria-hidden': 'true' }));
      } else {
        classes += ' is-free';
        column.appendChild(el('button', {
          type: 'button',
          class: classes,
          'data-action': 'new-booking',
          'data-resource-id': resource.id,
          'data-date': dayKey,
          'data-start': String(start),
          'data-day': String(dayIndex),
          'data-slot': String(slotIndex),
          tabindex: '-1',
          'aria-label': 'Book ' + resource.name + ' on ' + formatLongDate(dayKey) +
                        ' from ' + minutesToLabel12(start) + ' to ' + minutesToLabel12(end)
        }));
      }
    }

    // --- booking blocks -------------------------------------------------
    dayBookings.forEach(function (booking) {
      column.appendChild(buildBookingBlock(booking, resource, dayKey));
    });

    return column;
  }

  function buildBookingBlock(booking, resource, dayKey) {
    var slotIndex = (booking.start - GRID_OPEN) / SLOT;
    var slotCount = (booking.end - booking.start) / SLOT;
    var compact = slotCount <= 2;

    return el('button', {
      type: 'button',
      class: 'booking-block' + (compact ? ' is-small' : ''),
      'data-action': 'open-booking',
      'data-booking-id': booking.id,
      style: {
        top: 'calc(var(--slot-h) * ' + slotIndex + ' + 2px)',
        height: 'calc(var(--slot-h) * ' + slotCount + ' - 5px)'
      },
      'aria-label': resource.name + ', booked by ' + booking.name + ', ' +
        formatLongDate(dayKey) + ' ' + minutesToLabel12(booking.start) + ' to ' +
        minutesToLabel12(booking.end) + ', ' + booking.purpose + '. Open details.'
    }, [
      el('span', { class: 'bb-time', text: formatRange12(booking.start, booking.end) }),
      el('span', { class: 'bb-name', text: booking.name }),
      compact ? null : el('span', { class: 'bb-purpose', text: booking.purpose })
    ]);
  }

  /* -- insights ---------------------------------------------------------- */

  function renderInsights() {
    ui.insightList.textContent = '';

    if (!state.resources.length) {
      ui.insightList.appendChild(el('li', {}, [
        el('p', { class: 'empty-note', text: 'No resources yet, so there is nothing to measure.' })
      ]));
      return;
    }

    var now = currentNow();
    var weekEnd = addDays(viewWeekStart, 6);
    ui.insightSub.textContent = 'Week of ' + formatShortDate(viewWeekStart) + ' – ' +
      formatShortDate(weekEnd) + '.';

    state.resources.forEach(function (resource) {
      var percent = weekBusyPercent(state.bookings, resource, viewWeekStart);
      var count = weekBookings(resource.id, viewWeekStart).length;
      var next = findNextFreeSlot(state.bookings, resource, now.todayKey, now.nowMin, SLOT);

      var verdict = percent >= 75 ? 'Very busy'
        : percent >= 40 ? 'Steady'
        : percent > 0 ? 'Mostly free'
        : 'Completely free';

      ui.insightList.appendChild(el('li', { class: 'hue-' + resource.color + ' insight-item' }, [
        el('div', { class: 'insight-head' }, [
          el('span', { class: 'insight-name' }, [
            el('span', { 'aria-hidden': 'true', text: resource.emoji }),
            el('span', { text: resource.name })
          ]),
          el('span', { class: 'insight-pct', text: percent + '%' })
        ]),
        el('div', { class: 'res-bar', role: 'img', 'aria-label': percent + ' percent booked' }, [
          el('span', { style: { width: Math.max(percent, percent > 0 ? 4 : 0) + '%' } })
        ]),
        el('div', { class: 'insight-foot' }, [
          el('span', { html: '<b>' + escapeHtml(verdict) + '</b> · ' + escapeHtml(pluralise(count, 'booking')) }),
          el('span', {
            text: next
              ? 'Next free ' + formatRelativeDate(next.date) + ' ' + minutesToLabel12(next.start)
              : 'Fully booked for ' + SEARCH_DAYS + ' days'
          })
        ])
      ]));
    });
  }

  /* -- my bookings ------------------------------------------------------- */

  var myBookingsQuery = '';

  function renderMyBookings() {
    ui.myBookingsResult.textContent = '';

    if (!myBookingsQuery) {
      ui.myBookingsResult.appendChild(el('p', {
        class: 'empty-note',
        text: 'Enter your name to see what you have coming up.'
      }));
      return;
    }

    var now = currentNow();
    var mine = upcomingForName(myBookingsQuery, now);

    if (!mine.length) {
      var anyForName = state.bookings.filter(function (b) {
        return b.name.toLowerCase() === myBookingsQuery.toLowerCase();
      }).length;

      ui.myBookingsResult.appendChild(el('p', {
        class: 'empty-note',
        text: anyForName
          ? 'No upcoming bookings for “' + myBookingsQuery + '”. Your earlier ones have finished.'
          : 'Nothing found for “' + myBookingsQuery + '”. Check the spelling, or book a slot above.'
      }));
      return;
    }

    ui.myBookingsResult.appendChild(el('p', {
      class: 'result-head',
      text: pluralise(mine.length, 'upcoming booking') + ' for ' + myBookingsQuery + '.'
    }));

    var list = el('ul', { class: 'mine-list', role: 'list' });

    mine.forEach(function (booking) {
      var resource = getResource(booking.resourceId);
      if (!resource) return;
      var today = booking.date === now.todayKey;

      list.appendChild(el('li', { class: 'hue-' + resource.color + ' mine-item' }, [
        el('span', { class: 'mine-emoji', 'aria-hidden': 'true', text: resource.emoji }),
        el('span', { class: 'mine-text' }, [
          el('span', { class: 'mine-title' }, [
            document.createTextNode(resource.name),
            today ? el('span', { class: 'mine-badge', text: 'Today' }) : null
          ]),
          el('span', {
            class: 'mine-when',
            text: formatRelativeDate(booking.date) + ' · ' +
                  formatRange12(booking.start, booking.end) +
                  ' · ' + booking.purpose
          })
        ]),
        el('span', { class: 'mine-actions' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-soft',
            'data-action': 'open-booking',
            'data-booking-id': booking.id,
            text: 'Open'
          }),
          el('button', {
            type: 'button',
            class: 'btn btn-danger-soft',
            'data-action': 'cancel-booking',
            'data-booking-id': booking.id,
            'aria-label': 'Cancel ' + resource.name + ' on ' + formatLongDate(booking.date),
            text: 'Cancel'
          })
        ])
      ]));
    });

    ui.myBookingsResult.appendChild(list);
  }

  /* -- storage warning --------------------------------------------------- */

  /**
   * When the browser blocks localStorage there is nowhere to save. The page
   * used to say so in a status line; that section is gone, so the warning is
   * now a toast. It fires once per session — a toast on every keystroke that
   * saves would be noise, and the user cannot act on it more than once.
   */
  var storageWarned = false;

  function warnStorageBlocked() {
    if (storageWarned) return;
    storageWarned = true;
    showToast(
      'This browser is blocking local storage, so nothing can be saved. ' +
      'Everything still works, but it will be gone when you refresh.',
      { type: 'error', duration: 8000 }
    );
  }

  function renderAll() {
    renderResources();
    renderHeroStats();
    renderCalendar();
    renderInsights();
    renderMyBookings();
  }

  /* =======================================================================
     8. DIALOGS
        Native <dialog> gives us Esc-to-close, focus trapping and the top
        layer for free. The only thing it does inconsistently is restoring
        focus to whatever opened it, so that is handled here.
     ======================================================================= */

  var bookingDialog = $('#bookingDialog');
  var detailDialog = $('#detailDialog');
  var resourceDialog = $('#resourceDialog');
  var confirmDialog = $('#confirmDialog');

  var bookingForm = $('#bookingForm');
  var resourceForm = $('#resourceForm');

  var focusReturn = null;

  function rememberFocus() {
    focusReturn = document.activeElement;
  }

  function restoreFocus() {
    if (focusReturn && typeof focusReturn.focus === 'function' && document.contains(focusReturn)) {
      try { focusReturn.focus(); } catch (err) { /* element went away */ }
    }
    focusReturn = null;
  }

  function openDialog(dialog, focusTarget) {
    rememberFocus();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');   // very old browsers: still visible
    }
    var target = focusTarget || dialog.querySelector('input, select, button');
    if (target) {
      try { target.focus(); } catch (err) { /* not focusable yet */ }
    }
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  [bookingDialog, detailDialog, resourceDialog, confirmDialog].forEach(function (dialog) {
    dialog.addEventListener('close', restoreFocus);
    // Clicking the backdrop closes the dialog.
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog(dialog);
    });
  });

  document.addEventListener('click', function (event) {
    var closer = event.target.closest('[data-close-dialog]');
    if (closer) closeDialog(closer.closest('dialog'));
  });

  /* -- field error display ----------------------------------------------- */

  function setFieldError(input, errorEl, message) {
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function clearBookingErrors() {
    setFieldError($('#bkName'), $('#bkNameError'), '');
    setFieldError($('#bkPurpose'), $('#bkPurposeError'), '');
    setFieldError($('#bkDate'), $('#bkDateError'), '');
    setFieldError($('#bkStart'), $('#bkTimeError'), '');
    setFieldError($('#bkEnd'), $('#bkTimeError'), '');
    $('#conflictBox').hidden = true;
  }

  /* -- time selects ------------------------------------------------------ */

  function fillTimeSelects() {
    var startSelect = $('#bkStart');
    var endSelect = $('#bkEnd');
    startSelect.textContent = '';
    endSelect.textContent = '';

    for (var t = GRID_OPEN; t <= GRID_CLOSE; t += SLOT) {
      startSelect.appendChild(el('option', { value: String(t), text: minutesToLabel12(t) }));
      endSelect.appendChild(el('option', { value: String(t), text: minutesToLabel12(t) }));
    }
  }

  /* -- booking dialog ---------------------------------------------------- */

  var editingBookingId = null;

  function openBookingDialog(options) {
    var resource = getResource(options.resourceId);
    if (!resource) return;

    editingBookingId = options.bookingId || null;
    clearBookingErrors();

    var now = currentNow();
    var start = options.start !== undefined ? options.start : resource.open;
    var end = options.end !== undefined
      ? options.end
      : Math.min(start + Math.min(SLOT * 2, resource.maxMinutes), resource.close);

    $('#bookingDialogTitle').textContent = editingBookingId ? 'Edit booking' : 'New booking';
    $('#saveBookingBtn').textContent = editingBookingId ? 'Save changes' : 'Save booking';

    $('#bookingContext').textContent =
      resource.emoji + '  ' + resource.name + ' · open ' +
      formatRange12(resource.open, resource.close);

    $('#bkName').value = options.name || '';
    $('#bkPurpose').value = options.purpose || '';
    $('#bkDate').value = options.date || now.todayKey;
    $('#bkDate').min = now.todayKey;
    $('#bkStart').value = String(start);
    $('#bkEnd').value = String(end);

    updateRuleNote(resource);

    openDialog(bookingDialog, $('#bkName'));
  }

  function updateRuleNote(resource) {
    var start = Number($('#bkStart').value);
    var end = Number($('#bkEnd').value);
    var note = $('#ruleNote');

    if (!resource) { note.textContent = ''; return; }

    if (isFinite(start) && isFinite(end) && end > start) {
      var length = end - start;
      var over = length > resource.maxMinutes;
      note.innerHTML =
        'This slot would be <b>' + escapeHtml(formatDuration(length)) + '</b> long. ' +
        escapeHtml(resource.name) + ' allows up to <b>' +
        escapeHtml(formatDuration(resource.maxMinutes)) + '</b>.' +
        (over ? ' <b>That is too long.</b>' : '');
    } else {
      note.innerHTML = 'Maximum booking length for ' + escapeHtml(resource.name) +
        ' is <b>' + escapeHtml(formatDuration(resource.maxMinutes)) + '</b>.';
    }
  }

  /** Read the dialog fields into a plain object for the pure validator. */
  function readBookingForm() {
    var startValue = $('#bkStart').value;
    var endValue = $('#bkEnd').value;
    return {
      name: $('#bkName').value,
      purpose: $('#bkPurpose').value,
      date: $('#bkDate').value,
      start: startValue === '' ? null : Number(startValue),
      end: endValue === '' ? null : Number(endValue),
      resourceId: selectedResourceId,
      ignoreId: editingBookingId
    };
  }

  function handleBookingSubmit(event) {
    event.preventDefault();

    var resource = getResource(selectedResourceId);
    var input = readBookingForm();
    var result = validateBooking(input, resource, state.bookings, currentNow());

    clearBookingErrors();

    if (result.errors.name) setFieldError($('#bkName'), $('#bkNameError'), result.errors.name);
    if (result.errors.purpose) setFieldError($('#bkPurpose'), $('#bkPurposeError'), result.errors.purpose);
    if (result.errors.date) setFieldError($('#bkDate'), $('#bkDateError'), result.errors.date);
    if (result.errors.time) setFieldError($('#bkStart'), $('#bkTimeError'), result.errors.time);

    if (result.conflict) {
      showConflict(resource, result, input);
      return;
    }

    if (!result.valid) {
      var firstBad = bookingDialog.querySelector('[aria-invalid="true"]');
      if (firstBad) firstBad.focus();
      return;
    }

    commitBooking(resource, result, input);
  }

  function showConflict(resource, result, input) {
    var box = $('#conflictBox');
    $('#conflictTitle').textContent = result.conflicts.length > 1
      ? 'That clashes with ' + pluralise(result.conflicts.length, 'booking') + '.'
      : 'That clashes with an existing booking.';
    $('#conflictBody').textContent = result.message +
      (result.conflicts.length > 1
        ? ' It also overlaps ' + pluralise(result.conflicts.length - 1, 'other booking') + '.'
        : '');

    var duration = input.end - input.start;
    var suggestions = findSuggestions(
      resource, state.bookings, input.date, input.start, duration, 3, editingBookingId
    );

    var list = $('#suggestList');
    list.textContent = '';
    var wrap = $('#suggestWrap');

    if (suggestions.length) {
      wrap.hidden = false;
      suggestions.forEach(function (slot) {
        var sameDay = slot.date === input.date;
        var label = (sameDay ? '' : dayShort(slot.date) + ' ') +
          formatRange12(slot.start, slot.end);
        list.appendChild(el('button', {
          type: 'button',
          class: 'suggest-btn',
          'data-suggest-date': slot.date,
          'data-suggest-start': String(slot.start),
          'data-suggest-end': String(slot.end),
          text: label
        }));
      });
    } else {
      wrap.hidden = true;
    }

    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    $('#bkStart').focus();
  }

  function commitBooking(resource, result, input) {
    if (editingBookingId) {
      var existing = getBooking(editingBookingId);
      if (existing) {
        existing.name = input.name.trim();
        existing.purpose = input.purpose.trim();
        existing.date = input.date;
        existing.start = input.start;
        existing.end = input.end;
        showToast('Booking updated.', { type: 'ok' });
      }
    } else {
      state.bookings.push({
        id: makeId('bk'),
        resourceId: resource.id,
        name: input.name.trim(),
        purpose: input.purpose.trim(),
        date: input.date,
        start: input.start,
        end: input.end,
        createdAt: Date.now()
      });
      showToast(
        'Booked ' + resource.name + ' for ' + input.name.trim() + ', ' +
        formatRelativeDate(input.date) + ' ' + formatRange12(input.start, input.end) + '.',
        { type: 'ok' }
      );
      myBookingsQuery = input.name.trim();
      $('#whoInput').value = myBookingsQuery;
    }

    saveState();
    editingBookingId = null;
    closeDialog(bookingDialog);
    renderAll();
  }

  /* -- details dialog ---------------------------------------------------- */

  var detailBookingId = null;

  function openDetailDialog(bookingId) {
    var booking = getBooking(bookingId);
    if (!booking) return;
    var resource = getResource(booking.resourceId);
    if (!resource) return;

    detailBookingId = bookingId;

    var body = $('#detailBody');
    body.textContent = '';

    var resourceBox = el('div', { class: 'hue-' + resource.color + ' detail-banner' }, [
      el('span', { class: 'res-emoji', 'aria-hidden': 'true', text: resource.emoji }),
      el('div', {}, [
        el('div', { class: 'detail-banner-title', text: resource.name }),
        el('div', {
          class: 'detail-banner-sub',
          text: 'Open ' + formatRange12(resource.open, resource.close) +
                ' · max ' + formatDuration(resource.maxMinutes)
        })
      ])
    ]);
    body.appendChild(resourceBox);

    var now = currentNow();
    var finished = booking.date < now.todayKey ||
      (booking.date === now.todayKey && booking.end <= now.nowMin);

    var rows = [
      ['Booked by', booking.name, true],
      ['Purpose', booking.purpose, false],
      ['Date', formatLongDate(booking.date) + ' (' + formatRelativeDate(booking.date) + ')', false],
      ['Time', formatRange12(booking.start, booking.end) +
               '  (' + formatDuration(booking.end - booking.start) + ')', true],
      ['Status', finished ? 'Finished' : 'Upcoming', false]
    ];

    var list = el('div', { class: 'detail-list' });
    rows.forEach(function (row) {
      list.appendChild(el('div', { class: 'detail-row' }, [
        el('div', { class: 'detail-key', text: row[0] }),
        el('div', { class: 'detail-val' + (row[2] ? ' strong' : ''), text: row[1] })
      ]));
    });
    body.appendChild(list);

    $('#cancelBookingBtn').textContent = finished ? 'Delete record' : 'Cancel booking';

    openDialog(detailDialog, $('#editBookingBtn'));
  }

  /* -- resource dialog --------------------------------------------------- */

  /**
   * Keep the two live previews in the resource dialog honest:
   * the icon box mirrors whatever the icon input currently holds (falling back
   * to the default box when it is empty or invalid), and the swatch is tinted
   * by setting --res-h, the same variable the resource cards use.
   */
  function updateResourcePreviews() {
    var raw = $('#rsEmoji').value.trim();
    var valid = raw && !/[<>&"'/\\]/.test(raw);
    $('#iconPreview').textContent = valid ? sanitizeEmoji(raw) : '📦';

    var hues = { teal: 174, violet: 265, amber: 32, rose: 340, sky: 202, lime: 88 };
    var hue = hues[$('#rsColor').value];
    $('#colorSwatch').style.setProperty('--res-h', String(hue === undefined ? 174 : hue));
  }

  function openResourceDialog() {
    setFieldError($('#rsName'), $('#rsNameError'), '');
    setFieldError($('#rsEmoji'), $('#rsEmojiError'), '');
    resourceForm.reset();
    $('#rsEmoji').value = '📦';
    $('#rsMax').value = '120';
    updateResourcePreviews();
    openDialog(resourceDialog, $('#rsName'));
  }

  function handleResourceSubmit(event) {
    event.preventDefault();

    var name = $('#rsName').value.trim();
    var emojiRaw = $('#rsEmoji').value.trim();
    var color = $('#rsColor').value;
    var maxMinutes = Number($('#rsMax').value);

    setFieldError($('#rsName'), $('#rsNameError'), '');
    setFieldError($('#rsEmoji'), $('#rsEmojiError'), '');

    var ok = true;

    if (!name) {
      setFieldError($('#rsName'), $('#rsNameError'), 'Please give the resource a name.');
      ok = false;
    } else if (name.length < 2) {
      setFieldError($('#rsName'), $('#rsNameError'), 'Please use at least 2 characters.');
      ok = false;
    } else if (state.resources.some(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })) {
      setFieldError($('#rsName'), $('#rsNameError'), 'A resource with that name already exists.');
      ok = false;
    }

    if (emojiRaw && /[<>&"'/\\]/.test(emojiRaw)) {
      setFieldError($('#rsEmoji'), $('#rsEmojiError'),
        'Icons cannot contain < > & " \' / or \\ — please paste a single emoji.');
      ok = false;
    }

    if (!ok) {
      var bad = resourceDialog.querySelector('[aria-invalid="true"]');
      if (bad) bad.focus();
      return;
    }

    var resource = {
      id: makeId('res'),
      name: name,
      emoji: sanitizeEmoji(emojiRaw),
      color: COLORS.indexOf(color) !== -1 ? color : 'teal',
      maxMinutes: maxMinutes,
      open: GRID_OPEN,
      close: GRID_CLOSE
    };

    state.resources.push(resource);
    selectedResourceId = resource.id;
    saveState();
    closeDialog(resourceDialog);
    renderAll();
    showToast('Added “' + resource.name + '”. Its week is open.', { type: 'ok' });
  }

  /* -- confirmation ------------------------------------------------------ */

  var confirmResolver = null;

  function askConfirm(options) {
    $('#confirmTitle').textContent = options.title;
    $('#confirmBody').textContent = options.body;
    $('#confirmYesBtn').textContent = options.confirmLabel || 'Yes, do it';

    return new Promise(function (resolve) {
      confirmResolver = resolve;
      openDialog(confirmDialog, $('#confirmYesBtn'));
    });
  }

  $('#confirmYesBtn').addEventListener('click', function () {
    var resolve = confirmResolver;
    confirmResolver = null;
    closeDialog(confirmDialog);
    if (resolve) resolve(true);
  });

  confirmDialog.addEventListener('close', function () {
    var resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(false);
  });

  /* =======================================================================
     9. TOASTS
        aria-live="polite" on the host means a screen reader announces them.
        The Undo button is a real button, so it is keyboard reachable.
     ======================================================================= */

  function showToast(message, options) {
    options = options || {};

    var toast = el('div', { class: 'toast' + (options.type ? ' toast-' + options.type : '') });
    toast.appendChild(el('span', { class: 'toast-msg', text: message }));

    if (options.actionLabel && typeof options.onAction === 'function') {
      var action = el('button', {
        type: 'button',
        class: 'toast-action',
        text: options.actionLabel
      });
      action.addEventListener('click', function () {
        dismiss();
        options.onAction();
      });
      toast.appendChild(action);
    }

    var timer = window.setTimeout(dismiss, options.duration || UNDO_MS);
    var dismissed = false;

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      window.clearTimeout(timer);
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }

    ui.toastHost.appendChild(toast);
    return dismiss;
  }

  /* =======================================================================
     10. EVENT HANDLING
     ======================================================================= */

  /* -- theme ------------------------------------------------------------- */

  var themeToggle = $('#themeToggle');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = theme === 'dark' || (theme === 'auto' && prefersDark);

    themeToggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    themeToggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    themeToggle.querySelector('.theme-icon').textContent = isDark ? '☀️' : '🌙';
    themeToggle.querySelector('.theme-label').textContent = theme === 'auto' ? 'Auto' : (isDark ? 'Dark' : 'Light');
  }

  themeToggle.addEventListener('click', function () {
    var current = document.documentElement.getAttribute('data-theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDarkNow = current === 'dark' || (current === 'auto' && prefersDark);
    var next = isDarkNow ? 'light' : 'dark';
    writeTheme(next);
    applyTheme(next);
  });

  if (window.matchMedia) {
    var schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var onSchemeChange = function () {
      if (document.documentElement.getAttribute('data-theme') === 'auto') applyTheme('auto');
    };
    if (typeof schemeQuery.addEventListener === 'function') {
      schemeQuery.addEventListener('change', onSchemeChange);
    } else if (typeof schemeQuery.addListener === 'function') {
      schemeQuery.addListener(onSchemeChange);
    }
  }

  /* -- week navigation --------------------------------------------------- */

  $('#prevWeek').addEventListener('click', function () {
    viewWeekStart = addDays(viewWeekStart, -7);
    renderAll();
  });

  $('#nextWeek').addEventListener('click', function () {
    viewWeekStart = addDays(viewWeekStart, 7);
    renderAll();
  });

  $('#todayBtn').addEventListener('click', function () {
    viewWeekStart = startOfWeek(todayKey());
    renderAll();
    showToast('Back to ' + formatShortDate(viewWeekStart) + '.');
  });

  /* -- resource list (delegated) ----------------------------------------- */

  ui.resourceList.addEventListener('click', function (event) {
    var deleteBtn = event.target.closest('[data-delete-resource]');
    if (deleteBtn) {
      event.stopPropagation();
      requestDeleteResource(deleteBtn.getAttribute('data-delete-resource'));
      return;
    }

    var card = event.target.closest('[data-resource-id]');
    if (!card) return;

    selectedResourceId = card.getAttribute('data-resource-id');
    renderAll();
  });

  $('#addResourceBtn').addEventListener('click', openResourceDialog);

  function requestDeleteResource(resourceId) {
    var resource = getResource(resourceId);
    if (!resource) return;

    var count = state.bookings.filter(function (b) { return b.resourceId === resourceId; }).length;

    askConfirm({
      title: 'Delete “' + resource.name + '”?',
      body: count
        ? 'This removes the resource and ' + pluralise(count, 'booking') +
          ' attached to it. This cannot be undone.'
        : 'This removes the resource. It has no bookings, so nothing else is lost.',
      confirmLabel: 'Delete resource'
    }).then(function (confirmed) {
      if (!confirmed) return;

      var removedBookings = state.bookings.filter(function (b) { return b.resourceId === resourceId; });
      state.resources = state.resources.filter(function (r) { return r.id !== resourceId; });
      state.bookings = state.bookings.filter(function (b) { return b.resourceId !== resourceId; });

      if (selectedResourceId === resourceId) {
        selectedResourceId = state.resources.length ? state.resources[0].id : null;
      }

      saveState();
      renderAll();

      showToast('Deleted “' + resource.name + '”.', {
        actionLabel: 'Undo',
        onAction: function () {
          state.resources.push(resource);
          removedBookings.forEach(function (b) { state.bookings.push(b); });
          selectedResourceId = resource.id;
          saveState();
          renderAll();
          showToast('Restored “' + resource.name + '”.', { type: 'ok' });
        }
      });
    });
  }

  /* -- calendar (delegated) ---------------------------------------------- */

  ui.calGrid.addEventListener('click', function (event) {
    var newSlot = event.target.closest('[data-action="new-booking"]');
    if (newSlot) {
      openBookingDialog({
        resourceId: newSlot.getAttribute('data-resource-id'),
        date: newSlot.getAttribute('data-date'),
        start: Number(newSlot.getAttribute('data-start'))
      });
      return;
    }

    var block = event.target.closest('[data-action="open-booking"]');
    if (block) openDetailDialog(block.getAttribute('data-booking-id'));
  });

  /**
   * Arrow-key movement across the free slots of the grid.
   * Focus starts on the first free slot and then moves cell by cell,
   * skipping anything that is booked, past or closed.
   */
  ui.calGrid.addEventListener('keydown', function (event) {
    var slot = event.target.closest('.cal-slot.is-free');
    if (!slot) return;

    var deltas = {
      ArrowRight: [1, 0], ArrowLeft: [-1, 0],
      ArrowDown: [0, 1], ArrowUp: [0, -1],
      Home: [0, 'first'], End: [0, 'last']
    };

    if (event.key === 'Tab') return;

    var move = deltas[event.key];
    if (!move) return;
    event.preventDefault();

    var day = Number(slot.getAttribute('data-day'));
    var index = Number(slot.getAttribute('data-slot'));
    var target = null;

    if (move[1] === 'first' || move[1] === 'last') {
      var buttons = ui.calGrid.querySelectorAll(
        '.cal-slot.is-free[data-day="' + day + '"]'
      );
      target = move[1] === 'first' ? buttons[0] : buttons[buttons.length - 1];
    } else {
      var nextDay = day + move[0];
      var nextIndex = index + move[1];
      target = ui.calGrid.querySelector(
        '.cal-slot.is-free[data-day="' + nextDay + '"][data-slot="' + nextIndex + '"]'
      );

      // If that cell is not free, keep walking in the same direction.
      var guard = 0;
      while (!target && guard < 60) {
        guard++;
        if (move[0] !== 0) { nextDay += move[0]; if (nextDay < 0 || nextDay > 6) break; }
        if (move[1] !== 0) { nextIndex += move[1]; if (nextIndex < 0 || nextIndex > 47) break; }
        target = ui.calGrid.querySelector(
          '.cal-slot.is-free[data-day="' + nextDay + '"][data-slot="' + nextIndex + '"]'
        );
      }
    }

    if (target) target.focus();
  });

  // Keyboard navigation uses a single moving tab stop ("roving tabindex"):
  // whichever slot has focus becomes the one Tab reaches next time.
  ui.calGrid.addEventListener('focusin', function (event) {
    var slot = event.target.closest('.cal-slot.is-free');
    if (!slot) return;
    ui.calGrid.querySelectorAll('.cal-slot.is-free').forEach(function (btn) {
      btn.setAttribute('tabindex', '-1');
    });
    slot.setAttribute('tabindex', '0');
  });

  /* -- booking form ------------------------------------------------------ */

  bookingForm.addEventListener('submit', handleBookingSubmit);
  resourceForm.addEventListener('submit', handleResourceSubmit);

  ['#bkStart', '#bkEnd'].forEach(function (selector) {
    $(selector).addEventListener('change', function () {
      setFieldError($('#bkStart'), $('#bkTimeError'), '');
      updateRuleNote(getResource(selectedResourceId));
    });
  });

  ['#bkName', '#bkPurpose', '#bkDate'].forEach(function (selector) {
    $(selector).addEventListener('input', function () {
      var errorMap = { '#bkName': '#bkNameError', '#bkPurpose': '#bkPurposeError', '#bkDate': '#bkDateError' };
      setFieldError($(selector), $(errorMap[selector]), '');
      if (selector === '#bkDate') {
        $('#conflictBox').hidden = true;
      }
    });
  });

  // Clicking a suggested time rewrites the form and re-checks it.
  $('#suggestList').addEventListener('click', function (event) {
    var button = event.target.closest('[data-suggest-date]');
    if (!button) return;

    $('#bkDate').value = button.getAttribute('data-suggest-date');
    $('#bkStart').value = button.getAttribute('data-suggest-start');
    $('#bkEnd').value = button.getAttribute('data-suggest-end');
    $('#conflictBox').hidden = true;
    setFieldError($('#bkDate'), $('#bkDateError'), '');
    setFieldError($('#bkStart'), $('#bkTimeError'), '');
    updateRuleNote(getResource(selectedResourceId));
    $('#bkName').focus();
  });

  /* -- details dialog ---------------------------------------------------- */

  $('#editBookingBtn').addEventListener('click', function () {
    var booking = getBooking(detailBookingId);
    if (!booking) return;
    closeDialog(detailDialog);
    openBookingDialog({
      resourceId: booking.resourceId,
      bookingId: booking.id,
      name: booking.name,
      purpose: booking.purpose,
      date: booking.date,
      start: booking.start,
      end: booking.end
    });
  });

  $('#cancelBookingBtn').addEventListener('click', function () {
    var booking = getBooking(detailBookingId);
    closeDialog(detailDialog);
    if (booking) cancelBooking(booking.id);
  });

  /* -- cancelling with undo ---------------------------------------------- */

  function cancelBooking(bookingId) {
    var index = -1;
    for (var i = 0; i < state.bookings.length; i++) {
      if (state.bookings[i].id === bookingId) { index = i; break; }
    }
    if (index === -1) return;

    var booking = state.bookings[index];
    var resource = getResource(booking.resourceId);
    state.bookings.splice(index, 1);
    saveState();
    renderAll();

    var label = (resource ? resource.name + ' ' : '') + formatRelativeDate(booking.date) +
      ' ' + formatRange12(booking.start, booking.end);

    showToast('Cancelled ' + label + '.', {
      type: 'error',
      actionLabel: 'Undo',
      onAction: function () {
        state.bookings.splice(index, 0, booking);
        saveState();
        renderAll();
        showToast('Restored ' + label + '.', { type: 'ok' });
      }
    });
  }

  /* -- my bookings ------------------------------------------------------- */

  $('#myBookingsForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = $('#whoInput').value.trim();

    if (!name) {
      setFieldError($('#whoInput'), $('#whoError'), 'Please type the name you booked with.');
      $('#whoInput').focus();
      return;
    }
    if (name.length < 2) {
      setFieldError($('#whoInput'), $('#whoError'), 'That is too short — at least 2 characters, please.');
      $('#whoInput').focus();
      return;
    }

    setFieldError($('#whoInput'), $('#whoError'), '');
    myBookingsQuery = name;
    renderMyBookings();
  });

  $('#whoInput').addEventListener('input', function () {
    setFieldError($('#whoInput'), $('#whoError'), '');
  });

  // Live previews in the "Add a resource" dialog.
  $('#rsEmoji').addEventListener('input', function () {
    setFieldError($('#rsEmoji'), $('#rsEmojiError'), '');
    updateResourcePreviews();
  });
  $('#rsColor').addEventListener('change', updateResourcePreviews);

  // Cancel buttons inside the "My bookings" list.
  ui.myBookingsResult.addEventListener('click', function (event) {
    var openBtn = event.target.closest('[data-action="open-booking"]');
    if (openBtn) {
      openDetailDialog(openBtn.getAttribute('data-booking-id'));
      return;
    }
    var cancelBtn = event.target.closest('[data-action="cancel-booking"]');
    if (cancelBtn) cancelBooking(cancelBtn.getAttribute('data-booking-id'));
  });

  /* -- global keyboard --------------------------------------------------- */

  document.addEventListener('keydown', function (event) {
    // "/" jumps to the calendar, a small convenience for keyboard users.
    if (event.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) {
      event.preventDefault();
      var firstFree = ui.calGrid.querySelector('.cal-slot.is-free');
      if (firstFree) {
        firstFree.setAttribute('tabindex', '0');
        firstFree.focus();
      } else {
        $('#calendar').scrollIntoView({ block: 'start' });
      }
    }
  });

  /* =======================================================================
     11. INIT
     ======================================================================= */

  function init() {
    applyTheme(readTheme());
    fillTimeSelects();

    var loaded = loadState();
    state = loaded || buildSampleState();

    selectedResourceId = state.resources.length ? state.resources[0].id : null;
    viewWeekStart = startOfWeek(todayKey());

    // If a booking was somehow saved without storage, make sure it lands on disk.
    if (!loaded) saveState();

    renderAll();

    // Keep "today" honest if the page is left open across midnight.
    window.setInterval(function () {
      if (todayKey() !== lastSeenDay) {
        lastSeenDay = todayKey();
        renderAll();
      }
    }, 60000);
  }

  var lastSeenDay = todayKey();

  /* Expose the pure logic for js/tests.js and for console exploration. */
  window.SlotSync = {
    SLOT: SLOT,
    GRID_OPEN: GRID_OPEN,
    GRID_CLOSE: GRID_CLOSE,
    escapeHtml: escapeHtml,
    sanitizeEmoji: sanitizeEmoji,
    minutesToLabel: minutesToLabel,
    minutesToLabel12: minutesToLabel12,
    formatRange12: formatRange12,
    labelToMinutes: labelToMinutes,
    keyToDate: keyToDate,
    dateToKey: dateToKey,
    isValidKey: isValidKey,
    addDays: addDays,
    startOfWeek: startOfWeek,
    weekdayIndex: weekdayIndex,
    todayKey: todayKey,
    formatDuration: formatDuration,
    intervalsOverlap: intervalsOverlap,
    findOverlap: findOverlap,
    findAllOverlaps: findAllOverlaps,
    isPastWindow: isPastWindow,
    validateBooking: validateBooking,
    findSuggestions: findSuggestions,
    findNextFreeSlot: findNextFreeSlot,
    weekBusyPercent: weekBusyPercent,
    bookedMinutesForDay: bookedMinutesForDay,
    normaliseResource: normaliseResource,
    normaliseBooking: normaliseBooking,
    buildSampleState: buildSampleState,
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
