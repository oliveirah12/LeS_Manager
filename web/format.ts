/* Pure functions shared by the screens: no React and no browser APIs, so they run in the tests. */

/** Formats an exact decimal string in pt-BR without losing digits: thousands with dots, trimmed fraction. */
export function decimal(value: string | null | undefined) {
  if (value == null || value === '') return '—';
  const [sign, digits] = value.startsWith('-') ? ['−', value.slice(1)] : ['', value];
  const [integer, fraction = ''] = digits.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const trimmed = fraction.replace(/0+$/, '');
  return sign + grouped + (trimmed ? ',' + trimmed : '');
}
export const quantity = decimal;
/** Adds decimal strings with BigInt on the 12 places the database keeps, so a total never picks up a floating-point residue. */
function exactSum(values: string[]) {
  const total = values.reduce((sum, value) => {
    const [integer, fraction = ''] = value.split('.');
    return sum + BigInt(integer + fraction.padEnd(12, '0').slice(0, 12));
  }, 0n).toString().padStart(13, '0');
  return total.slice(0, -12) + '.' + total.slice(-12);
}
/** One line for the products of an order. Units are only added when they are all the same. */
export function productsSummary(items: { sku: string; symbol: string; planned: string }[]) {
  if (items.length === 1) return decimal(items[0].planned) + ' ' + items[0].symbol + ' ' + items[0].sku;
  const sameUnit = items.every(item => item.symbol === items[0].symbol);
  return items.length + ' produtos' + (sameUnit ? ' · ' + decimal(exactSum(items.map(item => item.planned))) + ' ' + items[0].symbol : '');
}
export const duration = (minutes: number) => (minutes >= 60 ? Math.floor(minutes / 60) + ' h ' : '') + (minutes % 60 ? (minutes % 60) + ' min' : minutes >= 60 ? '' : '0 min');

/** Costs keep 12 places in the database. Reading them needs far fewer, so a residue of the division never looks like a change. */
const readable = (text: string) => text.replace(/\d+\.\d{7,}/g, number => String(Number(Number(number).toFixed(6))));
const shownValue = (value: unknown) => value === null || value === undefined || value === '' ? '—' : readable(Array.isArray(value) ? value.join(' · ') || '—' : String(value));
/** Field, before and after for what a technical correction changed. */
export function revisionChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => [key, shownValue(before[key]), shownValue(after[key])] as [string, string, string]);
}

const currency = (digits: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: digits });
/** Money in reais. Small unit costs keep up to four decimals so per-gram costs stay readable. */
export function brl(value: string | number | null | undefined) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return currency(Math.abs(number) > 0 && Math.abs(number) < 1 ? 4 : 2).format(number);
}

/** Turns an ISO date (2026-01-31) into the Brazilian order (31/01/2026). */
export const displayDate = (value: string) => value.split('-').reverse().join('/');
export function fileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ' + unit;
}

/** Mirrors the backend rule: admin sees everything, and whoever operates a module can also view it. */
export const accessible = (permissions: string[], permission: string) => permissions.includes('admin') || permissions.includes(permission) ||
  (permission.endsWith(':view') && permissions.includes(permission.replace(':view', ':operate')));

/**
 * Suggests the real consumption of an input from the lost pieces and how much of them was printed.
 * Only a starting value for an editable field: the API stores what the person confirms.
 */
export function suggestedConsumption(
  planned: string, parts: { productId: string; planned: string }[],
  items: { productId: string; planned: string; lost: string; printedPercent: string }[],
) {
  const number = (value: string) => Number(value.trim().replace(',', '.'));
  const saved = parts.reduce((total, part) => {
    const item = items.find(row => row.productId === part.productId);
    if (!item) return total;
    const lost = number(item.lost);
    const printed = item.printedPercent.trim() ? number(item.printedPercent) : 100;
    if (!(lost > 0) || !(lost <= number(item.planned)) || !(printed >= 0 && printed <= 100)) return total;
    return total + number(part.planned) * (lost / number(item.planned)) * (1 - printed / 100);
  }, 0);
  if (saved <= 0) return planned;
  return String(Math.round(Math.max(0, number(planned) - saved) * 1000) / 1000);
}

const priceScale = 10n ** 12n;
/** Reads a typed decimal as an integer of 12 places, so the price preview never goes through a float. */
function scaled(text: string | null | undefined) {
  const match = /^(\d{1,18})(?:[.,](\d{1,12}))?$/.exec(text?.trim() ?? '');
  return match ? BigInt(match[1]) * priceScale + BigInt((match[2] ?? '').padEnd(12, '0')) : null;
}
const validMargin = (margin: bigint | null): margin is bigint => margin !== null && margin < 100n * priceScale && margin % (priceScale / 100n) === 0n;

export type PricingCost = { mode: 'VALUE' | 'PERCENT'; base: 'COST' | 'SALE'; value: string };
/**
 * The cost before the sale percentages, scaled by 100 × 10^24, and the share of the price left after margin and sale
 * percentages, scaled by 10^12. Null when a value cannot be read or no price can cover the margin.
 */
function pricingTerms(cost: string | null, marginPercent: string, costs: PricingCost[]) {
  const [unit, margin] = [scaled(cost), scaled(marginPercent)];
  const values = costs.map(row => ({ ...row, scaled: scaled(row.value) }));
  if (unit === null || unit <= 0n || !validMargin(margin) || values.some(row => row.scaled === null)) return null;
  const sum = (match: (row: PricingCost) => boolean) => values.filter(match).reduce((total, row) => total + row.scaled!, 0n);
  const fixed = sum(row => row.mode === 'VALUE');
  const costShare = sum(row => row.mode === 'PERCENT' && row.base === 'COST');
  const saleShare = sum(row => row.mode === 'PERCENT' && row.base === 'SALE');
  const total = (unit + fixed) * 100n * priceScale + unit * costShare;
  const divisor = 100n * priceScale - margin - saleShare;
  return divisor > 0n ? { total, divisor, margin, saleShare } : null;
}

/** Same rule as pricingBreakdown in the API: (cost + fixed + %cost) ÷ (1 − margin − Σ%sale), rounded up, with 4 places under R$ 1. */
export function suggestedPrice(cost: string | null, marginPercent: string, costs: PricingCost[] = []) {
  const terms = pricingTerms(cost, marginPercent, costs);
  if (!terms) return null;
  const bottom = terms.divisor * priceScale;
  const places = terms.total >= bottom ? 2 : 4;
  const power = 10n ** BigInt(places);
  const price = (terms.total * power + bottom - 1n) / bottom;
  const fraction = (price % power).toString().padStart(places, '0').replace(/0+$/, '');
  return (price / power).toString() + (fraction ? '.' + fraction : '');
}

/** Real margin when it falls short of the desired one, cut to 2 places so it never looks better than it is. */
export function marginShortfall(salePrice: string, cost: string | null, marginPercent: string, costs: PricingCost[] = []) {
  const price = scaled(salePrice);
  const terms = pricingTerms(cost, marginPercent, costs);
  if (price === null || price <= 0n || !terms) return null;
  // What is left of the price after every cost, as 100 × price × 10^24, so it compares with the margin without rounding.
  const left = 100n * price * priceScale - terms.total - price * terms.saleShare;
  if (left >= terms.margin * price) return null;
  const hundredths = left * 100n / (price * priceScale);
  const sign = hundredths < 0n ? '-' : '';
  const size = hundredths < 0n ? -hundredths : hundredths;
  return sign + (size / 100n) + '.' + (size % 100n).toString().padStart(2, '0');
}

export type TableFilter<T> = {
  id: string; label: string; options: { id: string; name: string }[];
  /** The row's value for this filter. A list matches when any of its values was selected. */
  value: (row: T) => string | string[] | null | undefined;
};
export const yesNoOptions = [{ id: 'yes', name: 'Sim' }, { id: 'no', name: 'Não' }];
export const yesNo = (value: boolean) => value ? 'yes' : 'no';

/** Keeps the rows that match every selected filter. An empty selection does not filter. */
export function applyFilters<T>(rows: T[], filters: TableFilter<T>[], selected: Record<string, string>) {
  const active = filters.filter(filter => selected[filter.id]);
  return rows.filter(row => active.every(filter => {
    const value = filter.value(row);
    return Array.isArray(value) ? value.includes(selected[filter.id]) : value === selected[filter.id];
  }));
}

export type SortValue = string | number | null | undefined;
export type SortDirection = 'asc' | 'desc';
export type SortState = { key: string; direction: SortDirection } | null;

// Ignores case and accents, and reads digits as numbers: "SKU-9" comes before "SKU-10".
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

function decimalParts(value: string) {
  const match = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(value.trim());
  if (!match || !(match[2] || match[3])) return null;
  const digits = match[2] + match[3];
  const significant = digits.replace(/^0+/, '');
  if (!significant) return { sign: 0, magnitude: 0, digits: '' };
  const magnitude = match[2].length + Number(match[4] ?? 0) - (digits.length - significant.length);
  return { sign: match[1] === '-' ? -1 : 1, magnitude, digits: significant.replace(/0+$/, '') };
}

/** Compares decimal strings exactly, without passing through a float. */
export function compareDecimal(a: string, b: string) {
  const x = decimalParts(a);
  const y = decimalParts(b);
  if (!x || !y) return collator.compare(a, b);
  if (x.sign !== y.sign) return x.sign < y.sign ? -1 : 1;
  const order = x.magnitude !== y.magnitude ? (x.magnitude < y.magnitude ? -1 : 1) : x.digits < y.digits ? -1 : x.digits > y.digits ? 1 : 0;
  return order * x.sign || 0;
}

const isEmpty = (value: SortValue) => value === null || value === undefined || value === '';

/** Sorts a copy of the rows. Ties keep their order, and empty values stay last in both directions. */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, direction: SortDirection, numeric = false) {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (isEmpty(a) || isEmpty(b)) return Number(isEmpty(a)) - Number(isEmpty(b));
    const exact = numeric || (typeof a === 'number' && typeof b === 'number');
    return factor * (exact ? compareDecimal(String(a), String(b)) : collator.compare(String(a), String(b)));
  });
}

/** Header click cycle: ascending, descending, then back to the default order. */
export function nextSort(current: SortState, key: string): SortState {
  if (current?.key !== key) return { key, direction: 'asc' };
  return current.direction === 'asc' ? { key, direction: 'desc' } : null;
}
export const sortParam = (sort: SortState) => sort ? sort.key + ':' + sort.direction : undefined;

/** Finds the screen whose path matches the address hash, ignoring case, slashes at the ends and URL encoding. */
export function pageFromHash<P extends string>(hash: string, paths: Record<P, string>): P | undefined {
  let path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  try { path = decodeURIComponent(path).toLowerCase(); } catch { return undefined; }
  return (Object.keys(paths) as P[]).find(page => paths[page] === path);
}

/** Estimate shown while typing. The API recalculates it in exact decimals when saving. */
export function saleEstimate(rows: { quantity: string; salePrice: string }[], discountPercent: string, feePercent: string) {
  const number = (value: string) => {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const priced = rows.filter(row => row.salePrice.trim() && row.quantity.trim());
  if (!priced.length) return null;
  const gross = priced.reduce((total, row) => total + number(row.quantity) * number(row.salePrice), 0);
  const discount = gross * number(discountPercent) / 100;
  const total = gross - discount;
  const fee = total * number(feePercent) / 100;
  return { gross, discount, total, fee, net: total - fee };
}
