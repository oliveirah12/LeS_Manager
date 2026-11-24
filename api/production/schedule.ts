import { Prisma, ProductionStatus } from '@prisma/client';

export type Period = { start: Date; end: Date };
export type ScheduledOrder = {
  number: number; status: ProductionStatus; plannedStart: Date; expectedEnd: Date; startedAt: Date | null; finishedAt: Date | null;
};

export const scheduleFields = {
  number: true, status: true, plannedStart: true, expectedEnd: true, startedAt: true, finishedAt: true,
} as const;

/** When an order holds its printer. A late print keeps it until someone finishes or cancels the order. */
export function busyPeriod(order: ScheduledOrder, now: Date): Period | null {
  if (order.status === 'CANCELED') return null;
  if (order.status === 'PLANNED') return { start: order.plannedStart, end: order.expectedEnd };
  const start = order.startedAt ?? order.plannedStart;
  if (order.status === 'DONE') return { start, end: order.finishedAt ?? order.expectedEnd };
  return { start, end: order.expectedEnd > now ? order.expectedEnd : now };
}

/** Ends are open, so a print may start at the exact minute the previous one ends. */
export const overlaps = (a: Period, b: Period) => a.start < b.end && b.start < a.end;

/** Narrows the search in the database. A running order has no filter on its end because a late one is busy until now. */
export const possibleClashes = ({ start, end }: Period): Prisma.ProductionOrderWhereInput => ({
  OR: [
    { status: 'PLANNED', plannedStart: { lt: end }, expectedEnd: { gt: start } },
    { status: 'PRINTING', startedAt: { lt: end } },
    { status: 'DONE', startedAt: { lt: end }, finishedAt: { gt: start } },
  ],
});

/** Whole periods, even past the window, so the calendar knows whether a print started near its edge still fits. */
export const busyWithin = (orders: ScheduledOrder[], window: Period, now: Date) => orders
  .flatMap(order => {
    const busy = busyPeriod(order, now);
    return busy && overlaps(busy, window) ? [{ number: order.number, start: busy.start, end: busy.end }] : [];
  })
  .sort((a, b) => a.start.getTime() - b.start.getTime());

export function findClash<T extends ScheduledOrder>(orders: T[], period: Period, now: Date) {
  for (const order of orders) {
    const busy = busyPeriod(order, now);
    if (busy && overlaps(busy, period)) return { order, busy };
  }
  return null;
}
