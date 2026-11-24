export type BusyPeriod = { number: number; start: string; end: string };

const slotsPerDay = 48;
const slotStep = 30;
const pad = (value: number) => String(value).padStart(2, '0');

export const localDay = (date: Date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
/** The same text a datetime-local field holds, in the browser's time zone. */
export const localValue = (date: Date) => localDay(date) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());

/** Six full weeks from Sunday, so the calendar keeps its height from one month to the next. */
export function monthDays(year: number, month: number) {
  const offset = new Date(year, month, 1).getDay();
  return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - offset + index));
}

/** A start fits when the whole print ends before the next order, and an end may touch the next start. */
export function slotFits(value: string, minutes: number, busy: BusyPeriod[], earliest: Date | null) {
  const start = new Date(value).getTime();
  const end = start + minutes * 60000;
  if (!Number.isFinite(start) || (earliest && start < earliest.getTime())) return false;
  return !busy.some(period => start < new Date(period.end).getTime() && new Date(period.start).getTime() < end);
}

export function freeSlots(day: Date, minutes: number, busy: BusyPeriod[], earliest: Date | null) {
  return Array.from({ length: slotsPerDay }, (_, index) => localValue(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, index * slotStep)))
    .filter(value => value.startsWith(localDay(day)) && slotFits(value, minutes, busy, earliest));
}
