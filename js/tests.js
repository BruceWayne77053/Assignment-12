/* =========================================================================
   SlotSync — tests.js

   These tests only touch the PURE logic exposed on window.SlotSync:
   time maths, interval overlap, validation and free-slot search.
   Nothing here reads the DOM or localStorage, so the results are the same
   on every machine and in every timezone.

   Open the browser console on index.html and they run automatically.
   You can also call:
       SlotSync.tests.run()     re-run everything
       SlotSync.tests.list()    list the test names

   A "test" is a name plus a function. If the function throws, the test
   failed; if it returns normally, it passed. Use assert(condition, message)
   to state what you expect.
   ========================================================================= */

(function () {
  'use strict';

  var api = window.SlotSync;
  if (!api) {
    console.error('SlotSync.tests: window.SlotSync is missing. Load js/app.js before js/tests.js.');
    return;
  }

  /* ---------------------------------------------------------------------
     Tiny test harness
     --------------------------------------------------------------------- */

  var tests = [];
  var failures = 0;

  function test(name, fn) {
    tests.push({ name: name, fn: fn });
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Expected a truthy value.');
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error((message || 'Values differ') +
        ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  }

  /* ---------------------------------------------------------------------
     Shared fixtures
     --------------------------------------------------------------------- */

  /**
   * A fixed "now" so past/future tests never depend on the clock.
   * Because this is midday, fixtures that need to be bookable default to
   * TOMORROW (2026-11-05); anything dated today and before 12:00 is
   * deliberately in the past. Tests about the past say their date explicitly.
   */
  var NOW = { todayKey: '2026-11-04', nowMin: 12 * 60 };   // Wed 4 Nov 2026, 12:00
  var TOMORROW = '2026-11-05';

  var RESOURCE = {
    id: 'res_test',
    name: 'Test Room',
    emoji: '🧪',
    color: 'teal',
    maxMinutes: 120,
    open: 8 * 60,     // 480
    close: 20 * 60    // 1200
  };

  /** A forty-minute-maximum resource, for the "too long" tests. */
  var SHORT_RESOURCE = Object.assign({}, RESOURCE, { id: 'res_short', maxMinutes: 40 });

  function booking(overrides) {
    return Object.assign({
      id: 'bk_x',
      resourceId: 'res_test',
      name: 'Ali',
      purpose: 'Testing',
      date: TOMORROW,
      start: 10 * 60,
      end: 11 * 60,
      createdAt: 0
    }, overrides);
  }

  function candidate(overrides) {
    return Object.assign({
      resourceId: 'res_test',
      date: TOMORROW,
      start: 10 * 60,
      end: 11 * 60
    }, overrides);
  }

  function form(overrides) {
    return Object.assign({
      name: 'Priya',
      purpose: 'Revision',
      date: TOMORROW,
      start: 10 * 60,
      end: 11 * 60
    }, overrides);
  }

  /* =====================================================================
     1. TIME HELPERS
     ===================================================================== */

  test('minutesToLabel: 600 becomes "10:00"', function () {
    assertEqual(api.minutesToLabel(600), '10:00');
  });

  test('minutesToLabel: pads single digit hours and minutes', function () {
    assertEqual(api.minutesToLabel(8 * 60 + 5), '08:05');
  });

  test('minutesToLabel: midnight and end of day', function () {
    assertEqual(api.minutesToLabel(0), '00:00');
    assertEqual(api.minutesToLabel(23 * 60 + 59), '23:59');
  });

  test('labelToMinutes: "10:30" becomes 630', function () {
    assertEqual(api.labelToMinutes('10:30'), 630);
  });

  test('labelToMinutes: round-trips every 30-minute slot of the grid', function () {
    for (var m = api.GRID_OPEN; m <= api.GRID_CLOSE; m += api.SLOT) {
      assertEqual(api.labelToMinutes(api.minutesToLabel(m)), m,
        'Round trip failed at ' + m + ' minutes');
    }
  });

  test('minutesToLabel12: morning times read as AM', function () {
    assertEqual(api.minutesToLabel12(8 * 60), '8:00 AM');
    assertEqual(api.minutesToLabel12(9 * 60 + 30), '9:30 AM');
    assertEqual(api.minutesToLabel12(11 * 60 + 30), '11:30 AM');
  });

  test('minutesToLabel12: midday is 12:00 PM, not 0:00 PM', function () {
    assertEqual(api.minutesToLabel12(12 * 60), '12:00 PM');
  });

  test('minutesToLabel12: afternoon and evening times read as PM', function () {
    assertEqual(api.minutesToLabel12(13 * 60), '1:00 PM');
    assertEqual(api.minutesToLabel12(14 * 60 + 30), '2:30 PM');
    assertEqual(api.minutesToLabel12(19 * 60 + 30), '7:30 PM');
  });

  test('minutesToLabel12: midnight is 12:00 AM, not 0:00 AM', function () {
    assertEqual(api.minutesToLabel12(0), '12:00 AM');
    assertEqual(api.minutesToLabel12(30), '12:30 AM');
  });

  test('minutesToLabel12: every grid slot produces a sensible label', function () {
    for (var m = api.GRID_OPEN; m <= api.GRID_CLOSE; m += api.SLOT) {
      var label = api.minutesToLabel12(m);
      assert(/^\d{1,2}:\d{2} (AM|PM)$/.test(label), 'Odd label at ' + m + ': ' + label);
      var hour = Number(label.split(':')[0]);
      assert(hour >= 1 && hour <= 12, 'Hour out of range at ' + m + ': ' + label);
    }
  });

  test('minutesToLabel12: 12-hour and 24-hour forms agree on the minute', function () {
    for (var m = 0; m < 24 * 60; m += 15) {
      var twelve = api.minutesToLabel12(m);
      var twentyFour = api.minutesToLabel(m);
      assertEqual(twelve.split(':')[1].slice(0, 2), twentyFour.split(':')[1],
        'Minutes disagree at ' + m);
    }
  });

  test('formatRange12: drops the repeated meridiem when both ends share it', function () {
    assertEqual(api.formatRange12(10 * 60, 11 * 60), '10:00 – 11:00 AM');
  });

  test('formatRange12: keeps both meridiems when the range crosses noon', function () {
    assertEqual(api.formatRange12(11 * 60, 13 * 60), '11:00 AM – 1:00 PM');
  });

  test('formatRange12: handles a midday start', function () {
    assertEqual(api.formatRange12(12 * 60, 14 * 60), '12:00 – 2:00 PM');
  });

  test('labelToMinutes: rejects nonsense instead of guessing', function () {
    assertEqual(api.labelToMinutes('25:00'), null);
    assertEqual(api.labelToMinutes('10:75'), null);
    assertEqual(api.labelToMinutes('ten'), null);
    assertEqual(api.labelToMinutes(''), null);
    assertEqual(api.labelToMinutes(null), null);
  });

  test('dateToKey / keyToDate round-trip across a year', function () {
    var key = '2026-01-01';
    for (var i = 0; i < 400; i++) {
      assertEqual(api.dateToKey(api.keyToDate(key)), key, 'Failed on ' + key);
      key = api.addDays(key, 1);
    }
  });

  test('addDays crosses month and year boundaries', function () {
    assertEqual(api.addDays('2026-11-30', 1), '2026-12-01');
    assertEqual(api.addDays('2026-12-31', 1), '2027-01-01');
    assertEqual(api.addDays('2027-01-01', -1), '2026-12-31');
    assertEqual(api.addDays('2026-03-01', -1), '2026-02-28');
  });

  test('addDays survives a daylight-saving change (no 23/25 hour days)', function () {
    // Late March and late October are the usual European DST switch weekends.
    var acrossSpring = api.addDays('2026-03-28', 1);
    var acrossAutumn = api.addDays('2026-10-24', 1);
    assertEqual(acrossSpring, '2026-03-29');
    assertEqual(acrossAutumn, '2026-10-25');
  });

  test('isValidKey rejects impossible calendar dates', function () {
    assert(api.isValidKey('2026-11-04') === true, '4 Nov 2026 should be valid');
    assert(api.isValidKey('2026-02-30') === false, '30 Feb should be rejected');
    assert(api.isValidKey('2026-13-01') === false, 'Month 13 should be rejected');
    assert(api.isValidKey('04-11-2026') === false, 'Wrong order should be rejected');
    assert(api.isValidKey('') === false, 'Empty string should be rejected');
  });

  test('startOfWeek lands on Monday for every day of one week', function () {
    var monday = api.startOfWeek('2026-11-04');
    assertEqual(monday, '2026-11-02', '4 Nov 2026 is a Wednesday, so Monday is 2 Nov');
    for (var i = 0; i < 7; i++) {
      assertEqual(api.startOfWeek(api.addDays(monday, i)), monday,
        'Day ' + i + ' of the week should map back to Monday');
    }
    assertEqual(api.startOfWeek('2026-11-08'), '2026-11-02', 'Sunday belongs to the week before');
    assertEqual(api.startOfWeek('2026-11-09'), '2026-11-09', 'Monday is its own week start');
  });

  test('weekdayIndex returns 0 for Monday through 6 for Sunday', function () {
    assertEqual(api.weekdayIndex('2026-11-02'), 0);
    assertEqual(api.weekdayIndex('2026-11-08'), 6);
  });

  /* =====================================================================
     2. OVERLAP — the core rule
     ===================================================================== */

  test('overlap: identical windows clash', function () {
    assert(api.intervalsOverlap(600, 660, 600, 660) === true);
  });

  test('overlap: touching boundaries do NOT clash (10:00-11:00 vs 11:00-12:00)', function () {
    assert(api.intervalsOverlap(600, 660, 660, 720) === false,
      'A booking that starts exactly when the previous one ends must be allowed');
  });

  test('overlap: touching the other way round also does NOT clash', function () {
    assert(api.intervalsOverlap(660, 720, 600, 660) === false,
      'The rule must be symmetric');
  });

  test('overlap: a booking fully inside another clashes', function () {
    assert(api.intervalsOverlap(615, 645, 600, 660) === true,
      '10:15-10:45 sits inside 10:00-11:00');
  });

  test('overlap: a booking that fully contains another clashes', function () {
    assert(api.intervalsOverlap(600, 720, 630, 690) === true,
      '10:00-12:00 contains 10:30-11:30');
  });

  test('overlap: partial overlap at the start clashes', function () {
    assert(api.intervalsOverlap(570, 630, 600, 660) === true, '09:30-10:30 vs 10:00-11:00');
  });

  test('overlap: partial overlap at the end clashes', function () {
    assert(api.intervalsOverlap(630, 690, 600, 660) === true, '10:30-11:30 vs 10:00-11:00');
  });

  test('overlap: one minute short of touching does NOT clash', function () {
    assert(api.intervalsOverlap(600, 659, 660, 720) === false, '10:00-10:59 vs 11:00-12:00');
    assert(api.intervalsOverlap(601, 660, 600, 600) === false, 'Empty window never clashes');
  });

  test('overlap: windows on different days never clash', function () {
    var bookings = [booking({ start: 600, end: 660 })];
    assertEqual(
      api.findOverlap(bookings, candidate({ date: api.addDays(TOMORROW, 1), start: 600, end: 660 })),
      null
    );
  });

  test('overlap: same time on a different resource never clashes', function () {
    var bookings = [booking({ resourceId: 'res_other', start: 600, end: 660 })];
    assertEqual(
      api.findOverlap(bookings, candidate({ resourceId: 'res_test', start: 600, end: 660 })),
      null
    );
  });

  test('findOverlap: returns the clashing booking itself', function () {
    var clash = booking({ start: 630, end: 690 });
    var bookings = [booking({ id: 'bk_a', start: 540, end: 600 }), clash];
    var found = api.findOverlap(bookings, candidate({ start: 600, end: 660 }));
    assert(found === clash, 'The clashing booking object should be returned');
  });

  test('findOverlap: ignoreId lets a booking be edited without clashing with itself', function () {
    var bookings = [booking({ id: 'bk_self', start: 600, end: 660 })];
    assert(api.findOverlap(bookings, candidate({ start: 600, end: 660 })) !== null,
      'Without ignoreId it should clash with itself');
    assertEqual(
      api.findOverlap(bookings, candidate({ start: 600, end: 660, ignoreId: 'bk_self' })),
      null,
      'With ignoreId it should be allowed'
    );
  });

  test('findAllOverlaps: reports every clashing booking, in time order', function () {
    var bookings = [
      booking({ id: 'bk_1', name: 'Ali', start: 600, end: 660 }),
      booking({ id: 'bk_2', name: 'Sam', start: 660, end: 720 }),   // touching, not a clash
      booking({ id: 'bk_3', name: 'Mei', start: 630, end: 690 })
    ];
    // The window is 10:00-11:00, so Ali (10:00-11:00) and Mei (10:30-11:30)
    // clash, while Sam (11:00-12:00) only touches the boundary.
    var found = api.findAllOverlaps(bookings, candidate({ start: 600, end: 660 }));
    assertEqual(found.length, 2, 'Ali and Mei clash; Sam only touches');
    assertEqual(found[0].name, 'Ali');
    assertEqual(found[1].name, 'Mei');
  });

  test('back-to-back chain of bookings fills an hour with no clashes', function () {
    var bookings = [
      booking({ id: 'bk_1', start: 600, end: 630 }),
      booking({ id: 'bk_2', start: 630, end: 660 }),
      booking({ id: 'bk_3', start: 660, end: 690 })
    ];
    bookings.forEach(function (b, index) {
      var others = bookings.filter(function (_, i) { return i !== index; });
      assertEqual(api.findOverlap(others, b), null, 'Booking ' + index + ' should not clash');
    });
  });

  /* =====================================================================
     3. PAST DATES AND TIMES
     ===================================================================== */

  test('past: yesterday is in the past', function () {
    assert(api.isPastWindow('2026-11-03', 600, NOW) === true);
  });

  test('past: tomorrow is not in the past', function () {
    assert(api.isPastWindow('2026-11-05', 600, NOW) === false);
  });

  test('past: an earlier time today is in the past', function () {
    assert(api.isPastWindow('2026-11-04', 11 * 60, NOW) === true,
      'At 12:00, an 11:00 slot has gone');
  });

  test('past: the slot starting right now is still bookable', function () {
    assert(api.isPastWindow('2026-11-04', 12 * 60, NOW) === false,
      'A slot starting at the current minute has not passed yet');
  });

  test('past: a later time today is bookable', function () {
    assert(api.isPastWindow('2026-11-04', 13 * 60, NOW) === false);
  });

  test('validation: a booking dated yesterday is rejected', function () {
    var result = api.validateBooking(form({ date: '2026-11-03' }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(!!result.errors.date, 'An error should be attached to the date field');
    assert(/past/i.test(result.errors.date), 'The message should say the date is in the past');
  });

  test('validation: a booking earlier today is rejected', function () {
    var result = api.validateBooking(
      form({ date: '2026-11-04', start: 9 * 60, end: 10 * 60 }), RESOURCE, [], NOW
    );
    assertEqual(result.valid, false);
    assert(/passed/i.test(result.errors.date), 'The message should say the time has passed');
  });

  /* =====================================================================
     4. VALIDATION RULES
     ===================================================================== */

  test('validation: a clean booking is accepted', function () {
    var result = api.validateBooking(form(), RESOURCE, [], NOW);
    assertEqual(result.valid, true, 'Errors: ' + JSON.stringify(result.errors));
    assertEqual(result.conflict, null);
  });

  test('validation: missing name is rejected with a friendly message', function () {
    var result = api.validateBooking(form({ name: '   ' }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(/name/i.test(result.errors.name));
  });

  test('validation: missing purpose is rejected', function () {
    var result = api.validateBooking(form({ purpose: '' }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(!!result.errors.purpose, 'The error should be attached to the purpose field');
    assert(/say what the slot is for/i.test(result.errors.purpose));
  });

  test('validation: missing date is rejected', function () {
    var result = api.validateBooking(form({ date: '' }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(/date/i.test(result.errors.date));
  });

  test('validation: end before start is rejected', function () {
    var result = api.validateBooking(form({ start: 700, end: 660 }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(/after the start/i.test(result.errors.time));
  });

  test('validation: end equal to start is rejected (zero-length booking)', function () {
    var result = api.validateBooking(form({ start: 660, end: 660 }), RESOURCE, [], NOW);
    assertEqual(result.valid, false);
    assert(/after the start/i.test(result.errors.time));
  });

  test('validation: a booking longer than the resource maximum is rejected', function () {
    var result = api.validateBooking(
      form({ start: 10 * 60, end: 13 * 60 }), SHORT_RESOURCE, [], NOW
    );
    assertEqual(result.valid, false);
    assert(/maximum/i.test(result.errors.time), 'Message should mention the maximum');
    assert(/40 minutes/i.test(result.errors.time), 'Message should state the actual limit');
  });

  test('validation: a 40-minute booking is rejected because times sit on 30-minute marks', function () {
    var result = api.validateBooking(
      form({ start: 10 * 60, end: 10 * 60 + 40 }), SHORT_RESOURCE, [], NOW
    );
    assertEqual(result.valid, false, '40 minutes is within the limit, but is not a grid boundary');
    assert(/30-minute mark/i.test(result.errors.time));
  });

  test('validation: exactly the resource maximum on a grid boundary is accepted', function () {
    var resource60 = Object.assign({}, RESOURCE, { maxMinutes: 60 });
    var result = api.validateBooking(form({ start: 600, end: 660 }), resource60, [], NOW);
    assertEqual(result.valid, true, 'Errors: ' + JSON.stringify(result.errors));
  });

  test('validation: one slot over the resource maximum is rejected on length, not alignment', function () {
    var resource60 = Object.assign({}, RESOURCE, { maxMinutes: 60 });
    var result = api.validateBooking(form({ start: 600, end: 690 }), resource60, [], NOW);
    assertEqual(result.valid, false);
    assert(/maximum/i.test(result.errors.time), 'This failure is about length, not the grid');
  });

  test('validation: times outside the resource opening hours are rejected', function () {
    var result = api.validateBooking(
      form({ date: '2026-11-05', start: 7 * 60, end: 9 * 60 }), RESOURCE, [], NOW
    );
    assertEqual(result.valid, false);
    assert(/open between/i.test(result.errors.time));
  });

  test('validation: times not on a 30-minute mark are rejected', function () {
    var result = api.validateBooking(
      form({ date: '2026-11-05', start: 605, end: 665 }), RESOURCE, [], NOW
    );
    assertEqual(result.valid, false);
    assert(/30-minute mark/i.test(result.errors.time));
  });

  /* =====================================================================
     5. CONFLICT REPORTING
     ===================================================================== */

  test('conflict: an overlapping booking is refused and named exactly', function () {
    var existing = booking({ id: 'bk_ali', name: 'Ali', start: 600, end: 660 });
    var result = api.validateBooking(
      form({ name: 'Sam', start: 630, end: 690 }), RESOURCE, [existing], NOW
    );
    assertEqual(result.valid, false);
    assert(result.conflict === existing, 'The clashing booking should be returned');
    assertEqual(result.message, "Overlaps with Ali's booking, 10:00 AM to 11:00 AM.");
  });

  test('conflict: back-to-back after an existing booking is allowed', function () {
    var existing = booking({ start: 600, end: 660 });
    var result = api.validateBooking(
      form({ start: 660, end: 720 }), RESOURCE, [existing], NOW
    );
    assertEqual(result.valid, true, 'Errors: ' + JSON.stringify(result.errors));
    assertEqual(result.conflict, null);
  });

  test('conflict: back-to-back before an existing booking is allowed', function () {
    var existing = booking({ start: 660, end: 720 });
    var result = api.validateBooking(
      form({ start: 600, end: 660 }), RESOURCE, [existing], NOW
    );
    assertEqual(result.valid, true, 'Errors: ' + JSON.stringify(result.errors));
  });

  test('conflict: a booking fully inside another is refused', function () {
    var existing = booking({ start: 600, end: 720 });
    var result = api.validateBooking(
      form({ start: 630, end: 690 }), RESOURCE, [existing], NOW
    );
    assertEqual(result.valid, false);
    assert(!!result.conflict);
  });

  test('conflict: several clashes are all reported', function () {
    var existing = [
      booking({ id: 'bk_1', name: 'Ali', start: 600, end: 660 }),
      booking({ id: 'bk_2', name: 'Mei', start: 660, end: 720 })
    ];
    var result = api.validateBooking(
      form({ start: 600, end: 720 }), RESOURCE, existing, NOW
    );
    assertEqual(result.conflicts.length, 2);
    assertEqual(result.message, "Overlaps with Ali's booking, 10:00 AM to 11:00 AM.");
  });

  test('conflict: editing a booking does not clash with its own old version', function () {
    var existing = booking({ id: 'bk_self', start: 600, end: 660 });
    var result = api.validateBooking(
      form({ start: 600, end: 660, ignoreId: 'bk_self' }), RESOURCE, [existing], NOW
    );
    assertEqual(result.valid, true, 'Errors: ' + JSON.stringify(result.errors));
  });

  /* =====================================================================
     6. SUGGESTIONS
     ===================================================================== */

  test('suggestions: a free day offers alternatives at the same length', function () {
    var suggestions = api.findSuggestions(RESOURCE, [], TOMORROW, 600, 60, 3);
    assertEqual(suggestions.length, 3);
    suggestions.forEach(function (slot) {
      assertEqual(slot.end - slot.start, 60, 'Every suggestion keeps the requested length');
      assert(slot.start !== 600, 'The slot that just failed is never offered');
    });
  });

  test('suggestions: none of them overlap an existing booking', function () {
    var bookings = [
      booking({ id: 'bk_1', start: 8 * 60, end: 13 * 60 })
    ];
    var suggestions = api.findSuggestions(RESOURCE, bookings, TOMORROW, 9 * 60, 60, 3);
    assert(suggestions.length > 0, 'There is free time in the afternoon');
    suggestions.forEach(function (slot) {
      assertEqual(
        api.findOverlap(bookings, {
          resourceId: RESOURCE.id, date: slot.date, start: slot.start, end: slot.end
        }),
        null,
        'Suggestion ' + api.minutesToLabel(slot.start) + ' must be genuinely free'
      );
    });
  });

  test('suggestions: the nearest free slot is offered first', function () {
    // 10:00-11:00 is taken, so a 60-minute request needs a window that clears
    // it entirely. 09:00-10:00 fits exactly and is nearer than 11:00-12:00.
    var bookings = [booking({ id: 'bk_1', start: 600, end: 660 })];
    var suggestions = api.findSuggestions(RESOURCE, bookings, TOMORROW, 600, 60, 1);
    assertEqual(suggestions.length, 1);
    assertEqual(suggestions[0].start, 540, '09:00-10:00 is the nearest 60-minute window');
    assertEqual(suggestions[0].end, 600, 'It ends exactly when the existing booking begins');
  });

  test('suggestions: a short request can slot in immediately after the clash', function () {
    var bookings = [booking({ id: 'bk_1', start: 600, end: 660 })];
    var suggestions = api.findSuggestions(RESOURCE, bookings, TOMORROW, 600, 30, 3);
    assertEqual(suggestions.length, 3, 'Three 30-minute windows should be offered');
    // Ranked by distance from the failed 10:00, ties going to the earlier time:
    // 09:30 (30 min away), 09:00 (60), 11:00 (60). 10:30 clashes, so it is skipped.
    assertEqual(suggestions[0].start, 570, '09:30-10:00 fits before the booking');
    assertEqual(suggestions[1].start, 540, '09:00-09:30 is the next nearest');
    assertEqual(suggestions[2].start, 660, '11:00-11:30 fits right after it');
  });

  test('suggestions: a full day rolls over to the following days', function () {
    var bookings = [];
    for (var m = RESOURCE.open; m + 60 <= RESOURCE.close; m += 60) {
      bookings.push(booking({ id: 'bk_' + m, start: m, end: m + 60 }));
    }
    var suggestions = api.findSuggestions(RESOURCE, bookings, TOMORROW, 600, 60, 2);
    assert(suggestions.length > 0, 'A completely full day should still produce later days');
    suggestions.forEach(function (slot) {
      assert(slot.date !== TOMORROW, 'Suggestions should move to another day');
    });
  });

  test('suggestions: a zero-length request returns nothing rather than crashing', function () {
    assertEqual(api.findSuggestions(RESOURCE, [], TOMORROW, 600, 0, 3).length, 0);
  });

  /* =====================================================================
     7. NEXT FREE SLOT AND BUSY PERCENTAGE
     ===================================================================== */

  test('nextFree: skips a booking that is running right now', function () {
    var bookings = [booking({ start: 11 * 60, end: 13 * 60 })];
    var next = api.findNextFreeSlot(bookings, RESOURCE, TOMORROW, 12 * 60, 30);
    assertEqual(next.date, TOMORROW);
    assertEqual(next.start, 13 * 60, 'The next free 30 minutes start when the booking ends');
  });

  test('nextFree: a completely free resource offers the requested time', function () {
    var next = api.findNextFreeSlot([], RESOURCE, TOMORROW, 10 * 60, 30);
    assertEqual(next.date, TOMORROW);
    assertEqual(next.start, 10 * 60);
  });

  test('nextFree: back-to-back counts as free', function () {
    var bookings = [booking({ start: 600, end: 660 })];
    var next = api.findNextFreeSlot(bookings, RESOURCE, TOMORROW, 600, 30);
    assertEqual(next.start, 660, '11:00 is free even though 10:00-11:00 is taken');
  });

  test('nextFree: searches into the following day when today is full', function () {
    var bookings = [];
    for (var m = RESOURCE.open; m < RESOURCE.close; m += 30) {
      bookings.push(booking({ id: 'bk_' + m, start: m, end: m + 30 }));
    }
    var next = api.findNextFreeSlot(bookings, RESOURCE, TOMORROW, RESOURCE.open, 30);
    assertEqual(next.date, api.addDays(TOMORROW, 1), 'The whole of tomorrow is taken');
    assertEqual(next.start, RESOURCE.open);
  });

  test('busy percentage: one hour of a twelve-hour day over seven days', function () {
    var bookings = [booking({ date: '2026-11-04', start: 600, end: 660 })];
    var percent = api.weekBusyPercent(bookings, RESOURCE, '2026-11-02');
    // 60 minutes out of 12 hours x 7 days = 5040 minutes -> 1.2%
    assertEqual(percent, 1.2);
  });

  test('busy percentage: a completely empty week is 0%', function () {
    assertEqual(api.weekBusyPercent([], RESOURCE, '2026-11-02'), 0);
  });

  test('busy percentage: overlapping data can never exceed 100%', function () {
    var bookings = [];
    for (var i = 0; i < 7; i++) {
      bookings.push(booking({ id: 'bk_' + i, date: api.addDays('2026-11-02', i),
        start: RESOURCE.open, end: RESOURCE.close }));
      bookings.push(booking({ id: 'bk_dup_' + i, date: api.addDays('2026-11-02', i),
        start: RESOURCE.open + 60, end: RESOURCE.close - 60 }));
    }
    assert(api.weekBusyPercent(bookings, RESOURCE, '2026-11-02') <= 100);
  });

  /* =====================================================================
     8. SECURITY AND DATA REPAIR
     ===================================================================== */

  test('escapeHtml neutralises a script tag', function () {
    var escaped = api.escapeHtml('<script>alert(1)</script>');
    assert(escaped.indexOf('<') === -1, 'No raw angle brackets may survive');
    assert(escaped.indexOf('&lt;script&gt;') === 0);
  });

  test('escapeHtml neutralises quotes and ampersands', function () {
    assertEqual(api.escapeHtml('a & b'), 'a &amp; b');
    assertEqual(api.escapeHtml('"quoted"'), '&quot;quoted&quot;');
    assertEqual(api.escapeHtml("it's"), 'it&#39;s');
  });

  test('escapeHtml handles null and undefined without throwing', function () {
    assertEqual(api.escapeHtml(null), '');
    assertEqual(api.escapeHtml(undefined), '');
    assertEqual(api.escapeHtml(0), '0');
  });

  test('sanitizeEmoji keeps a real emoji and rejects markup', function () {
    assertEqual(api.sanitizeEmoji('🔬'), '🔬');
    assertEqual(api.sanitizeEmoji('<img>'), '📦');
    assertEqual(api.sanitizeEmoji(''), '📦');
  });

  test('normaliseBooking drops records with impossible times', function () {
    assertEqual(api.normaliseBooking({ name: 'A', purpose: 'B', date: '2026-11-04',
      start: 700, end: 600 }), null, 'End before start must be dropped');
    assertEqual(api.normaliseBooking({ name: 'A', purpose: 'B', date: 'not-a-date',
      start: 600, end: 660 }), null, 'A bad date must be dropped');
    assertEqual(api.normaliseBooking({ name: 'A', purpose: 'B', date: '2026-11-04',
      start: 605, end: 665 }), null, 'Off-grid times must be dropped');
    assertEqual(api.normaliseBooking(null), null);
    assertEqual(api.normaliseBooking('nonsense'), null);
  });

  test('normaliseBooking keeps a valid record', function () {
    var clean = api.normaliseBooking({
      id: 'bk_1', resourceId: 'res_test', name: 'Ali', purpose: 'Lab',
      date: '2026-11-04', start: 600, end: 660
    });
    assert(clean !== null, 'A valid booking should survive');
    assertEqual(clean.start, 600);
    assertEqual(clean.end, 660);
  });

  test('normaliseResource repairs missing opening hours', function () {
    var resource = api.normaliseResource({ name: 'Thing', emoji: '📦', color: 'not-a-colour' });
    assertEqual(resource.open, api.GRID_OPEN);
    assertEqual(resource.close, api.GRID_CLOSE);
    assertEqual(resource.color, 'teal', 'An unknown colour falls back to the default');
    assertEqual(resource.maxMinutes, 120);
  });

  test('normaliseResource rejects a nameless resource', function () {
    assertEqual(api.normaliseResource({ name: '   ' }), null);
    assertEqual(api.normaliseResource({}), null);
  });

  test('sample data ships no clashes of its own', function () {
    var sample = api.buildSampleState();
    assert(sample.resources.length >= 4, 'There should be at least four sample resources');
    assert(sample.bookings.length > 0, 'There should be sample bookings');

    sample.bookings.forEach(function (b, index) {
      var others = sample.bookings.filter(function (_, i) { return i !== index; });
      assertEqual(
        api.findOverlap(others, {
          resourceId: b.resourceId, date: b.date, start: b.start, end: b.end
        }),
        null,
        'Sample booking ' + index + ' (' + b.name + ' ' + b.date + ') clashes with another'
      );
    });
  });

  test('sample data only books resources that exist', function () {
    var sample = api.buildSampleState();
    var ids = sample.resources.map(function (r) { return r.id; });
    sample.bookings.forEach(function (b) {
      assert(ids.indexOf(b.resourceId) !== -1, 'Unknown resource: ' + b.resourceId);
    });
  });

  /* =====================================================================
     RUNNER
     ===================================================================== */

  function run() {
    var passed = 0;
    failures = 0;

    console.log('%cSlotSync logic tests', 'font-weight:bold;font-size:13px;color:#0d7268');
    console.log('Running ' + tests.length + ' tests against window.SlotSync…\n');

    tests.forEach(function (item) {
      try {
        item.fn();
        passed++;
      } catch (err) {
        failures++;
        console.error('✗ ' + item.name + '\n    ' + err.message);
      }
    });

    var summary = passed + ' passed, ' + failures + ' failed, ' + tests.length + ' total';

    if (failures === 0) {
      console.log('%c✓ ' + summary, 'color:#14663a;font-weight:bold');
      console.log('All good. The conflict logic behaves as described in the README.');
    } else {
      console.error('✗ ' + summary);
    }

    return { passed: passed, failed: failures, total: tests.length };
  }

  function list() {
    tests.forEach(function (item, index) {
      console.log((index + 1) + '. ' + item.name);
    });
    return tests.length;
  }

  window.SlotSync.tests = { run: run, list: list, tests: tests };

  run();
})();
