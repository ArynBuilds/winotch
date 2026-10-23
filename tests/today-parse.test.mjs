// Today's quick add (core/today-parse.ts): "Call Sarah tomorrow 3pm" is a
// title, a day and a time. Every rule, on a fixed clock: Sunday 18 October
// 2026, 14:00 (the island's own, local, time).

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseQuick, dayFromIso, isoOf, weekdayOf, mondayOf, dayOf } = await import("../src/core/today-parse.ts");

const SUNDAY = new Date(2026, 9, 18, 14, 0);
const WEDNESDAY = new Date(2026, 9, 21, 9, 30);
const SATURDAY = new Date(2026, 9, 24, 10, 0);

/** [what is typed, title, date, time], read on Sunday 14:00 unless `now` says otherwise. */
function expect(text, title, date, time, now = SUNDAY) {
  assert.deepEqual(parseQuick(text, now), { title, date, time }, text);
}

test("the user's example: a title, tomorrow, 3pm", () => {
  expect("Call Sarah tomorrow 3pm", "Call Sarah", "2026-10-19", "15:00");
});

test("a line with no day or time is all title, numbers included", () => {
  expect("Buy milk", "Buy milk", null, null);
  expect("Buy 3 apples", "Buy 3 apples", null, null);
  expect("Read 10 pages", "Read 10 pages", null, null);
  expect("Meet Ana at the cafe", "Meet Ana at the cafe", null, null);
  expect("Fix the Monthly report", "Fix the Monthly report", null, null);
  expect("Plan the wedding", "Plan the wedding", null, null);
  expect("I sat down with the sun", "I sat down with the sun", null, null);
});

test("today, tonight, tomorrow and the day after", () => {
  expect("Pay rent today", "Pay rent", "2026-10-18", null);
  expect("Dinner tonight", "Dinner", "2026-10-18", "20:00");
  expect("Dinner tonight at 8", "Dinner", "2026-10-18", "20:00");
  expect("Pick up the parcel by tomorrow", "Pick up the parcel", "2026-10-19", null);
  expect("Call Sarah tmrw 3:30 pm", "Call Sarah", "2026-10-19", "15:30");
  expect("Call tmr", "Call", "2026-10-19", null);
  expect("Gym the day after tomorrow", "Gym", "2026-10-20", null);
  expect("TOMORROW 3PM call", "call", "2026-10-19", "15:00");
  expect("tomorrow", "", "2026-10-19", null);
});

test("weekdays: the next one, never today; this week's; next week's", () => {
  expect("Dentist friday 9am", "Dentist", "2026-10-23", "09:00");
  expect("Dentist on Friday at 9", "Dentist", "2026-10-23", "09:00");
  expect("Party saturday", "Party", "2026-10-24", null);
  expect("Brunch on sun", "Brunch", "2026-10-25", null, SUNDAY);
  expect("Standup monday", "Standup", "2026-10-19", null);
  expect("Gym mon", "Gym", "2026-10-19", null);
  expect("Review thurs", "Review", "2026-10-22", null);
  expect("Monday meeting notes", "meeting notes", "2026-10-19", null);
  // Said on a Wednesday.
  expect("Report friday", "Report", "2026-10-23", null, WEDNESDAY);
  expect("Report this friday", "Report", "2026-10-23", null, WEDNESDAY);
  expect("Report next friday", "Report", "2026-10-30", null, WEDNESDAY);
  expect("Call wednesday", "Call", "2026-10-28", null, WEDNESDAY);
  expect("Call this wednesday", "Call", "2026-10-21", null, WEDNESDAY);
  // "sat" and "sun" are words too: only after on, this or next.
  expect("Brunch sun", "Brunch sun", null, null);
  expect("Hike next sat", "Hike", "2026-10-24", null);
});

test("in so many days, weeks, months, hours and minutes", () => {
  expect("Pay rent in 3 days", "Pay rent", "2026-10-21", null);
  expect("Review in 2 weeks", "Review", "2026-11-01", null);
  expect("Renew in a month", "Renew", "2026-11-18", null);
  expect("Check in a week", "Check", "2026-10-25", null);
  expect("Stretch in 30 minutes", "Stretch", "2026-10-18", "14:30");
  expect("Call back in 2 hours", "Call back", "2026-10-18", "16:00");
  expect("Leave in an hour", "Leave", "2026-10-18", "15:00");
  expect("Leave in half an hour", "Leave", "2026-10-18", "14:30");
  expect("Wake the server in 12 hours", "Wake the server", "2026-10-19", "02:00");
  expect("Invoice at the end of the month in 31 days", "Invoice at the end of the month", "2026-11-18", null);
});

test("weeks, weekends and months by name", () => {
  expect("Ship next week", "Ship", "2026-10-19", null);
  expect("Plan next month", "Plan", "2026-11-18", null);
  expect("Hike this weekend", "Hike", "2026-10-18", null, SUNDAY);
  expect("Hike this weekend", "Hike", "2026-10-24", null, WEDNESDAY);
  expect("Hike next weekend", "Hike", "2026-10-31", null, WEDNESDAY);
  expect("Clean over the weekend", "Clean", "2026-10-24", null, SATURDAY);
});

test("dates: day and month either way, numbers month first unless they cannot be, ISO", () => {
  expect("Taxes 21 Oct", "Taxes", "2026-10-21", null);
  expect("Taxes Oct 21", "Taxes", "2026-10-21", null);
  expect("Taxes October 21st", "Taxes", "2026-10-21", null);
  expect("Taxes on the 21st of October", "Taxes", "2026-10-21", null);
  expect("Taxes on 21 oct 2027", "Taxes", "2027-10-21", null);
  expect("Taxes Oct 21, 2027", "Taxes", "2027-10-21", null);
  expect("Taxes 10/21", "Taxes", "2026-10-21", null);
  expect("Taxes 21/10", "Taxes", "2026-10-21", null);
  expect("Taxes 10/21/2027", "Taxes", "2027-10-21", null);
  expect("Taxes 10/21/27", "Taxes", "2027-10-21", null);
  expect("Taxes 2026-12-01", "Taxes", "2026-12-01", null);
  expect("Dentist Nov 3 at 4:15pm", "Dentist", "2026-11-03", "16:15");
  // Passed this year: next year's.
  expect("Party Oct 1", "Party", "2027-10-01", null);
  expect("Party 9/30", "Party", "2027-09-30", null);
  // No such day: left in the title.
  expect("Feb 30 thing", "Feb 30 thing", null, null);
  expect("Taxes 2026-02-30", "Taxes 2026-02-30", null, null);
});

test("times: am/pm, 24 h, an hour alone, noon and midnight, the day's halves", () => {
  expect("Call mom at 15:00", "Call mom", "2026-10-18", "15:00");
  expect("Meet at 5", "Meet", "2026-10-18", "17:00");
  expect("Email @ 4pm", "Email", "2026-10-18", "16:00");
  expect("Call 4.30pm", "Call", "2026-10-18", "16:30");
  expect("Call 4:30 p.m.", "Call", "2026-10-18", "16:30");
  expect("Meet at 10:30", "Meet", "2026-10-19", "10:30");
  expect("Run at 12 am tomorrow", "Run", "2026-10-19", "00:00");
  // A time that has passed today is tomorrow's.
  expect("Meet at 1", "Meet", "2026-10-19", "13:00");
  expect("Gym at 7:30am", "Gym", "2026-10-19", "07:30");
  expect("Lunch at noon", "Lunch", "2026-10-19", "12:00");
  expect("Deploy at midnight", "Deploy", "2026-10-19", "00:00");
  // The day's halves: a hint for an hour alone, else their own time.
  expect("Run tomorrow morning", "Run", "2026-10-19", "09:00");
  expect("Call tomorrow evening at 7", "Call", "2026-10-19", "19:00");
  expect("Read in the afternoon", "Read", "2026-10-18", "15:00");
  expect("Call at 3 tomorrow", "Call", "2026-10-19", "15:00");
  expect("Breakfast at 9 tomorrow", "Breakfast", "2026-10-19", "09:00");
  // Not a time: a number with no "at" and no am/pm.
  expect("Buy 12 eggs tomorrow", "Buy 12 eggs", "2026-10-19", null);
  expect("Room 401 friday", "Room 401", "2026-10-23", null);
});

test("what is left reads as a title: hanging words and punctuation go", () => {
  expect("Call Sarah, tomorrow", "Call Sarah", "2026-10-19", null);
  expect("Call Sarah - tomorrow at 3pm", "Call Sarah", "2026-10-19", "15:00");
  expect("tomorrow: call Sarah", "call Sarah", "2026-10-19", null);
  expect("  Call   Sarah   tomorrow  ", "Call Sarah", "2026-10-19", null);
  expect("Book a table for friday", "Book a table", "2026-10-23", null);
  expect("Send the deck due tomorrow", "Send the deck", "2026-10-19", null);
});

test("days as numbers round-trip and know their weekday", () => {
  const d = dayFromIso("2026-10-18");
  assert.equal(isoOf(d), "2026-10-18");
  assert.equal(weekdayOf(d), 0, "a Sunday");
  assert.equal(isoOf(mondayOf(d)), "2026-10-12");
  assert.equal(isoOf(mondayOf(d + 1)), "2026-10-19");
  assert.equal(dayOf(SUNDAY), d);
  assert.equal(dayFromIso("2026-02-29"), null);
  assert.equal(dayFromIso("2028-02-29") - dayFromIso("2028-02-28"), 1);
  assert.equal(dayFromIso("18/10/2026"), null);
});
