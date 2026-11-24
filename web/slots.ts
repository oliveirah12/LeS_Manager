export type BusyPeriod = { number: number; start: string; end: string };

const pad = (value: number) => String(value).padStart(2, '0');
const time = (value: string) => new Date(value).getTime();

export const localDay = (date: Date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
/** The same text a datetime-local field holds, in the browser's time zone. */
export const localValue = (date: Date) => localDay(date) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());

/** Six full weeks from Sunday, so the calendar keeps its height from one month to the next. */
export function monthDays(year: number, month: number) {
  const offset = new Date(year, month, 1).getDay();
  return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - offset + index));
}

/** Everything that holds the printer on a day, including prints that cross midnight. */
export function dayPeriods(day: Date, busy: BusyPeriod[]) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return busy.filter(period => time(period.start) < end && start < time(period.end));
}

/** What blocks a start. Before the duration is known, the start itself still counts as one minute. */
export function clashingPeriods(value: string, minutes: number, busy: BusyPeriod[]) {
  const start = time(value);
  if (!Number.isFinite(start)) return [];
  const end = start + Math.max(minutes, 1) * 60000;
  return busy.filter(period => start < time(period.end) && time(period.start) < end);
}
