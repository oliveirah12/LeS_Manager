const assert = require('node:assert/strict');
const { test } = require('node:test');
const { busyPeriod, busyWithin, findClash, overlaps } = require('../dist/api/production/schedule.js');

const at = hour => new Date(Date.UTC(2026, 10, 23, hour));
const order = values => ({ number: 1, status: 'PLANNED', plannedStart: at(10), expectedEnd: at(12), startedAt: null, finishedAt: null, ...values });
const period = (start, end) => ({ start: at(start), end: at(end) });

test('a print may start at the exact time the previous one ends', () => {
  assert.equal(overlaps(period(10, 12), period(12, 14)), false);
  assert.equal(overlaps(period(10, 12), period(11, 13)), true);
  assert.equal(overlaps(period(10, 14), period(11, 12)), true);
});

test('each status holds the printer for its own period', () => {
  const now = at(13);
  assert.deepEqual(busyPeriod(order(), now), period(10, 12));
  assert.equal(busyPeriod(order({ status: 'CANCELED' }), now), null);
  assert.deepEqual(busyPeriod(order({ status: 'DONE', startedAt: at(9), finishedAt: at(11) }), now), period(9, 11));
  assert.deepEqual(busyPeriod(order({ status: 'PRINTING', startedAt: at(9), expectedEnd: at(15) }), now), period(9, 15));
});

test('a late print stays busy until now', () => {
  const late = order({ status: 'PRINTING', startedAt: at(9), expectedEnd: at(11) });
  assert.deepEqual(busyPeriod(late, at(13)), period(9, 13));
  assert.equal(findClash([late], period(12, 14), at(13)).order.number, 1);
  assert.equal(findClash([late], period(13, 14), at(13)), null);
});

test('the agenda lists whole periods in time order and only what touches the window', () => {
  const orders = [
    order({ number: 3, plannedStart: at(14), expectedEnd: at(20) }),
    order({ number: 2, plannedStart: at(8), expectedEnd: at(11) }),
    order({ number: 4, plannedStart: at(1), expectedEnd: at(2) }),
    order({ number: 5, status: 'CANCELED' }),
  ];
  assert.deepEqual(busyWithin(orders, period(10, 15), at(9)), [
    { number: 2, start: at(8), end: at(11) },
    { number: 3, start: at(14), end: at(20) },
  ]);
});

test('a canceled order never clashes', () => {
  assert.equal(findClash([order({ status: 'CANCELED' })], period(10, 12), at(9)), null);
});
