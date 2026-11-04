# SlotSync — a shared-resource booking scheduler

A single-page, offline-first booking scheduler for shared university resources: lab
equipment, study rooms, the hostel washing machine, the sports court. It replaces the
paper sign-up sheet with a weekly calendar that **cannot** produce a double-booking.

Built with plain HTML, CSS and JavaScript. No frameworks, no libraries, no build step,
no backend. Open `index.html` and it runs.

---
Website Link: https://brucewayne77053.github.io/Assignment-12/

## 1. The problem

Shared resources are scarce and physical. Today they are booked with a paper sheet on a
wall or messages in a WhatsApp group, which causes four predictable failures:

| Failure | What it costs |
| --- | --- |
| Two people write on the same line | A double-booking; one person walks over for nothing |
| No shared view of free time | People must physically go and look, or give up |
| Silent no-shows | The resource sits idle while others are turned away |
| No written record | Disputes are settled by volume, not by evidence |

SlotSync addresses all four with one idea: **the schedule is the source of truth, and it
refuses to hold two overlapping bookings for the same resource.**

---

## 2. Features

**Resources**
- Name, emoji icon, card colour and a maximum booking length per resource.
- The add-resource form shows a **live icon preview** beside the icon input, so you can
  see exactly how the emoji will look on the card before saving. The colour field is
  labelled **Card colour** with a swatch, and its hint explains that it is purely a
  visual label — it tints the resource's card and its bookings, nothing more.
- Four realistic sample resources and sample bookings are pre-loaded, so the page is
  never empty on first open.
- Add and delete resources (deleting warns you how many bookings go with it).

**Time format**
- All times are shown in **12-hour format** ("2:00 PM"), throughout: the calendar time
  column, booking blocks, the time dropdowns, the conflict messages, the "next free"
  labels and the detail dialog.
- A range that shares one meridiem is compressed for readability, so 10:00–11:00 shows
  as "10:00 – 11:00 AM" and 11:00–13:00 shows as "11:00 AM – 1:00 PM".
- Internally time is still stored as minutes from midnight, so nothing about the
  underlying time maths changed.

**Weekly calendar**
- Seven days across the top, 30-minute slots down the side, 8:00 AM–8:00 PM.
- Previous week, Next week and Today buttons; the current day is highlighted in the
  column header and the grid.
- Free, booked, past and out-of-hours slots are distinguished by **colour + pattern +
  text label**, so they remain readable in greyscale, for colour-blind users, and in
  high-contrast mode.
- The legend is a true key: each swatch mirrors the real cell it describes — same fill,
  same border, same hatching. The grey hatching uses its own `--hatch-grey` token tuned
  to about 3.4:1 against its fill in light mode and 4.1:1 in dark, so the pattern is
  actually visible rather than a faint smudge.
- The grid scrolls inside its own container; it never breaks the page layout.

**Booking**
- Click or tap any free slot to open a form pre-filled with that date and start time.
- Name, purpose, date, start time, end time.
- Field-level error messages written in plain language ("That is in the past — pick a
  date from today onwards"), tied to the input with `aria-describedby`.

**Conflict detection** (the core logic)
- Two bookings for the same resource may never overlap.
- Back-to-back bookings are allowed: one ending at 10:00 and the next starting at 10:00
  is fine.
- Also rejected: bookings in the past, bookings longer than the resource's limit,
  end time at or before start time, and incomplete forms.
- On a conflict, the dialog names the exact clashing booking ("Overlaps with Ali's
  booking, 10:00 to 11:00") and offers the two or three nearest free windows as
  one-click buttons.

**Managing bookings**
- Click a booking to see its details, edit it, or cancel it.
- Cancelling shows a toast with an **Undo** button (5 second window).
- "My bookings": type your name to see upcoming bookings, each with a quick cancel.

**Insights**
- Per resource: percentage of available time booked this week, and the next free slot.

**Saving**
- Everything persists in `localStorage`, wrapped in `try/catch` so the site still works
  when storage is blocked (private windows, locked-down browsers). If saving fails, a
  toast says so once — everything keeps working, it just forgets on refresh.

**About section**
- On the page: the problem, who it helps, and how to use it in three steps.

---

## 3. How to run

1. Download or copy the `SlotSync` folder.
2. Double-click `index.html`. That is it — no install, no server, no internet needed
   after the first load (the Google Font is optional; a system font stack takes over if
   it cannot load).

To run the logic tests, open the browser console (`F12` → Console) after loading the
page. `js/tests.js` runs automatically and prints a table. You can also type:

```js
SlotSync.tests.run();          // run everything again
SlotSync.tests.list();         // list the test names
```

---

## 4. File structure

```
SlotSync/
├── index.html          Markup: all sections and the four dialogs
├── css/
│   └── styles.css      Design tokens, layout, components, themes, responsive rules
├── js/
│   ├── app.js          The whole app, in commented sections
│   └── tests.js        Pure-logic tests, runnable from the console
└── README.md
```

Inside `js/app.js` the sections are, in order:

1. **Constants** — slot size, opening hours, storage key.
2. **Helpers** — escaping, DOM building, formatting.
3. **Date & time helpers** — date keys, week maths, 12-hour labels.
4. **Conflict & validation logic** — pure functions, no DOM, no storage.
5. **Storage** — safe read/write with `try/catch`.
6. **Data** — sample data, resource and booking accessors.
7. **Rendering** — resources, calendar, insights, my-bookings.
8. **Dialogs** — open/close, focus management, validation display.
9. **Toasts** — transient messages and the Undo action.
10. **Event handling** — wiring, delegation, keyboard support.
11. **Init** — boot sequence.

---

## 5. Design decisions

**How data is stored.** One object under one `localStorage` key
(`slotsync.v1`), shaped `{ version, resources: [], bookings: [] }`. A version number
means a future change can migrate old data instead of crashing on it. Reading is
defensive: every record is validated field-by-field on load, and anything malformed is
dropped rather than trusted. If storage throws (blocked, full, corrupted), the app falls
back to an in-memory object and warns you with a toast — every feature keeps working, it
just forgets on refresh.

**How time is stored.** Dates are plain `"YYYY-MM-DD"` strings. Times are **integers
counting minutes from midnight** (10:00 → `600`, 10:30 → `630`). No `Date` object is ever
stored, and no time is ever converted to UTC. This is the single most important trick in
the project: timezone offsets and daylight-saving shifts simply cannot corrupt a
comparison between two integers. A `Date` is constructed only for display, and
`new Date(y, m, d)` is used with explicit parts (never `new Date("2026-11-04")`, which
parses as UTC and can land on the wrong day).

**How conflict detection works.** A booking occupies a *half-open interval*
`[start, end)`. Two intervals overlap when:

```
aStart < bEnd  AND  bStart < aEnd
```

The comparison is strictly `<`, not `<=`. That single choice is what makes back-to-back
bookings legal: 10:00–11:00 and 11:00–12:00 give `600 < 660 && 660 < 720` on one side and
`660 < 660` — false — on the other, so no clash. A booking fully inside another
(10:15–10:45 against 10:00–11:00) satisfies both conditions, so it is caught. All of
this is a pure function, `intervalsOverlap()`, with no knowledge of the DOM or storage,
which is why it can be tested in isolation.

**Suggestions on conflict.** When a slot is refused, the app searches forward in
15-minute steps from the requested start, and also tries the start of the resource's
next open period, collecting the first windows that fit both the requested duration and
the resource's limit. It returns up to three, labelled with the actual times.

**Rendering.** The calendar is built from a document fragment and swapped in one go,
rather than patching DOM nodes cell by cell. With 7 days × 24 slots = 168 cells, this
keeps re-renders instant on a phone. Booking blocks are absolutely positioned over the
grid using `grid-row` spans so a two-hour booking reads as one tall block.

**Dialog behaviour.** Native `<dialog>` with `showModal()` is used rather than a
hand-built modal: the browser then provides Esc-to-close, focus trapping, inert
background content and the top-layer stacking for free — accessibility we would otherwise
have to reimplement badly. A small focus-restore shim returns focus to whatever opened
the dialog (native `<dialog>` does this inconsistently across browsers).

**Design.** A single palette with one accent (teal) plus per-resource hues, all defined
as CSS custom properties. `Outfit` is loaded as the display font with a full system-font
fallback stack, so the page never waits on the network to be readable. Light and dark
themes are driven by `data-theme` on `<html>`; the default `auto` follows
`prefers-color-scheme` and the manual toggle is remembered in storage. Spacing runs on a
`--sp-*` scale so rhythm is consistent rather than improvised.

**Safety.** Every piece of user text (names, purposes, resource names, emoji) passes
through `escapeHtml()` before it reaches `innerHTML`, and the app avoids `innerHTML` for
anything else — attribute values are set with `setAttribute`/`textContent`. Emoji input
is length-limited and stripped of URL-ish characters.

---

## 6. Accessibility notes

- **Semantics.** `header`/`main`/`section`/`footer`, one `h1`, headings in order, real
  `<button>` for anything clickable, `<ul role="list">` for lists that have list-style
  removed, a `skip-link` to the calendar, and `lang="en"`.
- **Keyboard.** Every action is reachable and operable by keyboard. The calendar grid is
  a keyboard-navigable group: slots are buttons, Arrow keys move between slots, `Enter` or
  `Space` opens the booking form, and focus is restored to the slot you came from.
  Dialogs close on Esc and keep focus inside.
- **Labels.** Every input and select has a visible `<label for>`. Errors are
  `role="alert"` and linked with `aria-describedby`. Required fields are marked in text
  ("*" plus the word required in the legend context), not by colour alone.
- **Announcements.** Toasts and validation messages sit in `aria-live` regions; the
  booking dialog's conflict box is `role="alert"` so a screen reader hears the clash
  immediately.
- **Contrast.** All text/background pairs meet WCAG AA (4.5:1 for body text, 3:1 for
  large text and UI borders) in both themes. Slot state also carries a text label, so
  meaning never depends on colour.
- **Focus visibility.** A 3px high-contrast `:focus-visible` outline on all interactive
  elements, never removed, and it strengthens in dark mode.
- **Motion.** All transitions and animations are inside
  `@media (prefers-reduced-motion: no-preference)` or explicitly disabled under
  `prefers-reduced-motion: reduce`.
- **Zoom and reflow.** Layout works at 320–360px wide, at 200% zoom, and the calendar
  scrolls in two axes rather than clipping or overflowing the page.

---

