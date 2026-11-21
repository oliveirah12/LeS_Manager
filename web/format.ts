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

/** Finds the screen whose path matches the address hash, ignoring case, slashes at the ends and URL encoding. */
export function pageFromHash<P extends string>(hash: string, paths: Record<P, string>): P | undefined {
  let path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  try { path = decodeURIComponent(path).toLowerCase(); } catch { return undefined; }
  return (Object.keys(paths) as P[]).find(page => paths[page] === path);
}
