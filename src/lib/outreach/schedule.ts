/**
 * When emails go out: weekday mornings in San Diego time, spaced a few
 * minutes apart, with a daily cap. Morning B2B emails get the most opens,
 * and a steady trickle protects a new sender's Gmail reputation.
 */

const TZ = "America/Los_Angeles";

export interface SlotOptions {
  startHour?: number;
  endHour?: number;
  /** Minutes between two emails from the same restaurant */
  spacingMin?: number;
  dailyCap?: number;
  /** 0–1, for a little jitter so sends don't land on round minutes */
  random?: () => number;
}

type Parts = { y: number; m: number; d: number; h: number; mi: number; weekday: number };

export function pacificParts(at: Date): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), weekday };
}

/** The moment that is y-m-d h:mi on a San Diego clock (handles daylight saving). */
export function fromPacific(y: number, m: number, d: number, h: number, mi = 0): Date {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want + 8 * 3_600_000;
  for (let i = 0; i < 2; i++) {
    const p = pacificParts(new Date(t));
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - want;
  }
  return new Date(t);
}

const sameDay = (a: Parts, b: Parts) => a.y === b.y && a.m === b.m && a.d === b.d;

/**
 * The first send time at or after `after` inside the sending window, at
 * least `spacingMin` from any time already taken, on a weekday that hasn't
 * reached the cap. Searches up to three weeks ahead.
 */
export function nextSendSlot(after: Date, taken: Date[], opts: SlotOptions = {}): Date {
  const { startHour = 9, endHour = 11, spacingMin = 4, dailyCap = 20, random = Math.random } = opts;
  const spacing = spacingMin * 60_000;
  const start = pacificParts(after);
  for (let offset = 0; offset < 21; offset++) {
    const noon = fromPacific(start.y, start.m, start.d, 12);
    const day = pacificParts(new Date(noon.getTime() + offset * 86_400_000));
    if (day.weekday === 0 || day.weekday === 6) continue;
    const onDay = taken.filter((t) => sameDay(pacificParts(t), day));
    if (onDay.length >= dailyCap) continue;
    const open = fromPacific(day.y, day.m, day.d, startHour);
    const close = fromPacific(day.y, day.m, day.d, endHour);
    let candidate = new Date(Math.max(open.getTime(), after.getTime()) + Math.floor(random() * 120) * 1000);
    while (candidate < close) {
      const clash = onDay.find((t) => Math.abs(t.getTime() - candidate.getTime()) < spacing);
      if (!clash) return candidate;
      candidate = new Date(clash.getTime() + spacing + Math.floor(random() * 60) * 1000);
    }
  }
  throw new Error("No send slot in the next three weeks.");
}

/** Days after the first email for each follow-up. */
export const FOLLOW_UP_DAYS = [4, 10] as const;
