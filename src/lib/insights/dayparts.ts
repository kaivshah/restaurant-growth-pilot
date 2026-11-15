/**
 * One definition of the day parts, shared by the insights, the AI's data
 * tools, the store brief and the pages, so "lunch" means the same hours
 * everywhere: the Subway lunch rush is 11 am–2 pm.
 */
export const DAY_PARTS = [
  { key: "morning", name: "morning (before 11 am)", hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { key: "lunch", name: "lunch (11 am–2 pm)", hours: [11, 12, 13] },
  { key: "afternoon", name: "afternoon (2–5 pm)", hours: [14, 15, 16] },
  { key: "dinner", name: "dinner (5–8 pm)", hours: [17, 18, 19] },
  { key: "late", name: "late (8 pm onwards)", hours: [20, 21, 22, 23] },
] as const;

export type DayPartKey = (typeof DAY_PARTS)[number]["key"];

export const LUNCH_HOURS: readonly number[] = DAY_PARTS[1].hours;
export const AFTERNOON_HOURS: readonly number[] = DAY_PARTS[2].hours;
export const LUNCH_LABEL = "11 am–2 pm";
export const AFTERNOON_LABEL = "2–5 pm";

export function dayPartOf(hour24: number): DayPartKey {
  return (DAY_PARTS.find((p) => (p.hours as readonly number[]).includes(hour24)) ?? DAY_PARTS[0]).key;
}
