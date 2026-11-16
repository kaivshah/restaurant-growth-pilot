/**
 * What day it is, for the AI: the date and weekday, the season, US holidays
 * and observances in the next six weeks (worked out here, no API), and the
 * local events the area scan found. Offers can then be timed: a holiday
 * week, a game day, a school break.
 */

export interface CalendarEvent {
  title: string;
  date: string;
  daysAhead: number;
  category: string;
  venue: string | null;
  attendance: number | null;
  distanceMiles: number | null;
}

const PACIFIC = "America/Los_Angeles";

function ymd(d: Date) {
  return d.toLocaleDateString("en-CA", { timeZone: PACIFIC });
}
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}
function lastWeekday(year: number, month: number, weekday: number) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - offset));
}
function easter(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1, day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

/** US holidays and food-relevant observances for a year: name, date, and how a restaurant can use it. */
export function usHolidays(year: number): { name: string; date: string; note: string }[] {
  const fixed = (m: number, d: number) => new Date(Date.UTC(year, m, d));
  const tg = nthWeekday(year, 10, 4, 4);
  const list: [string, Date, string][] = [
    ["New Year's Day", fixed(0, 1), "quiet day; resolutions: fresh and lighter subs"],
    ["Martin Luther King Jr. Day", nthWeekday(year, 0, 1, 3), "schools and offices closed: family lunches"],
    ["Super Bowl Sunday", nthWeekday(year, 1, 0, 2), "the biggest catering and group-order day: giant subs, platters"],
    ["Valentine's Day", fixed(1, 14), "pairs: two-for deals, cookies"],
    ["Presidents' Day", nthWeekday(year, 1, 1, 3), "long weekend; schools closed"],
    ["St. Patrick's Day", fixed(2, 17), "evening crowds; green-themed treats"],
    ["Easter", easter(year), "family gatherings; catering platters the day before"],
    ["Cinco de Mayo", fixed(4, 5), "evening traffic; spicy subs"],
    ["Mother's Day", nthWeekday(year, 4, 0, 2), "family meals; cookie platters"],
    ["Memorial Day", lastWeekday(year, 4, 1), "long weekend; picnics and giant subs"],
    ["Father's Day", nthWeekday(year, 5, 0, 3), "family meals; footlong deals"],
    ["Independence Day", fixed(6, 4), "picnics and parties: platters, bundles; quiet in-store"],
    ["Labor Day", nthWeekday(year, 8, 1, 1), "long weekend; end of summer; schools back soon"],
    ["Halloween", fixed(9, 31), "evening treats: cookies, kids' meals"],
    ["Veterans Day", fixed(10, 11), "honour deals"],
    ["Thanksgiving", tg, "the day itself is dead; the days before are big for office lunches and catering"],
    ["Black Friday", new Date(tg.getTime() + 86_400_000), "shoppers out all day: quick lunches, drinks"],
    ["Christmas Eve", fixed(11, 24), "early close; office parties the week before"],
    ["Christmas Day", fixed(11, 25), "closed or quiet"],
    ["New Year's Eve", fixed(11, 31), "evening traffic; party platters"],
  ];
  return list.map(([name, date, note]) => ({ name, date: date.toISOString().slice(0, 10), note })).sort((a, b) => a.date.localeCompare(b.date));
}

export function season(month: number): string {
  return month >= 2 && month <= 4 ? "spring" : month >= 5 && month <= 7 ? "summer" : month >= 8 && month <= 10 ? "fall" : "winter";
}

/** School calendar in broad strokes (US public schools): the AI should treat it as a hint, not a fact. */
function schoolNote(month: number, day: number): string {
  if (month === 5 && day > 10) return "most schools let out for summer in mid-June";
  if (month === 6 || month === 7) return "summer break: no after-school rush; families and camps";
  if (month === 7 && day > 15) return "schools go back in late August";
  if (month === 11 && day > 18) return "winter break from about Dec 20 to Jan 3";
  if (month === 2 && day > 20) return "spring break falls in late March or early April";
  return "school in session: an after-school window around 2:30–4 pm on weekdays";
}

export function calendarFor(now: Date, events: CalendarEvent[]) {
  const today = ymd(now);
  const [y, m, d] = today.split("-").map(Number);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: PACIFIC });
  const until = new Date(now.getTime() + 42 * 86_400_000);
  const holidays = [...usHolidays(y), ...usHolidays(y + 1)]
    .filter((h) => h.date >= today && h.date <= ymd(until))
    .map((h) => ({ ...h, days_ahead: Math.round((Date.parse(`${h.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) }));
  return {
    source: "Today's date, the US holiday calendar, and the area scan's events",
    today,
    weekday,
    season: season(m - 1),
    school: schoolNote(m - 1, d),
    holidays_next_6_weeks: holidays,
    local_events_next_30_days: events.slice(0, 20).map((e) => ({ title: e.title, date: e.date, days_ahead: e.daysAhead, category: e.category, venue: e.venue, attendance: e.attendance, distance_miles: e.distanceMiles })),
  };
}
