import { Prisma } from '@prisma/client';

const accented = 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ';
const plain = 'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn';
/** Fixed text, never user input. Comparing without accents needs no database extension. */
const withoutAccents = (column: 'sku' | 'name') => Prisma.raw(`translate("${column}", '${accented}', '${plain}')`);

/** What was typed: a LIKE pattern for products and, when it reads as one, an order number such as 12 or #12. */
export function orderSearch(text: string) {
  const clean = text.trim().normalize('NFD').replace(/\p{M}/gu, '');
  const number = /^#?\d{1,9}$/.test(clean) ? Number(clean.replace('#', '')) : null;
  return { pattern: '%' + clean.replace(/[\\%_]/g, '\\$&') + '%', number };
}

export async function matchingProductIds(db: Pick<Prisma.TransactionClient, '$queryRaw'>, pattern: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Product"
    WHERE ${withoutAccents('sku')} ILIKE ${pattern} ESCAPE '\\' OR ${withoutAccents('name')} ILIKE ${pattern} ESCAPE '\\'`;
  return rows.map(row => row.id);
}
