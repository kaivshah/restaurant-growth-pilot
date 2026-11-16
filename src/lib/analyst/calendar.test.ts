import { describe, expect, it } from "vitest";
import { calendarFor, usHolidays } from "./calendar";

describe("calendar for the AI", () => {
  it("works out the floating US holidays", () => {
    const h = Object.fromEntries(usHolidays(2026).map((x) => [x.name, x.date]));
    expect(h["Thanksgiving"]).toBe("2026-11-26");
    expect(h["Black Friday"]).toBe("2026-11-27");
    expect(h["Super Bowl Sunday"]).toBe("2026-02-08");
    expect(h["Easter"]).toBe("2026-04-05");
    expect(h["Memorial Day"]).toBe("2026-05-25");
    expect(h["Labor Day"]).toBe("2026-09-07");
  });

  it("lists what's ahead in the next six weeks, with the scanned events", () => {
    const now = new Date("2026-11-16T18:00:00Z");
    const cal = calendarFor(now, [{ title: "Biotech Summit", date: "2026-11-26", daysAhead: 10, category: "conference", venue: "Event Hall", attendance: 1200, distanceMiles: 1.7 }]);
    expect(cal.today).toBe("2026-11-16");
    expect(cal.weekday).toBe("Monday");
    expect(cal.season).toBe("fall");
    expect(cal.holidays_next_6_weeks.map((h) => h.name)).toEqual(["Thanksgiving", "Black Friday", "Christmas Eve", "Christmas Day"]);
    expect(cal.holidays_next_6_weeks[0].days_ahead).toBe(10);
    expect(cal.local_events_next_30_days[0].title).toBe("Biotech Summit");
  });
});
