import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { colorAverage, sumValues } from '../stock/cost';

/** A color of the recipe: any active input of this type, material group and color, in one unit family. */
export type ColorKey = { typeId: string; groupId: string | null; colorId: string };

export const colorLabelSelect = {
  id: true, typeId: true, groupId: true, colorId: true, familyId: true,
  type: { select: { name: true } }, group: { select: { name: true } }, color: { select: { name: true } },
} as const satisfies Prisma.ColorInputSelect;
type LabeledColor = Prisma.ColorInputGetPayload<{ select: typeof colorLabelSelect }>;

/** "Filamento · PLA · Preto": the type, the material group when there is one, and the color. */
export const colorLabel = (row: Pick<LabeledColor, 'type' | 'group' | 'color'>) =>
  [row.type.name, row.group?.name, row.color.name].filter(Boolean).join(' · ');

export const colorKey = (row: ColorKey) => [row.typeId, row.groupId ?? '', row.colorId].join('|');

/** The brands that can fill a color today. Inactive products and other unit families stay out. */
export const colorMembers = (color: ColorKey & { familyId: string }): Prisma.ProductWhereInput => ({
  active: true, type: { isInput: true }, typeId: color.typeId, groupId: color.groupId, colorId: color.colorId, unit: { familyId: color.familyId },
});

/**
 * Colors that active inputs offer today, for the recipe to choose from. Products without a color are left out,
 * since only a color makes brands interchangeable.
 */
export async function colorOptions(db: Prisma.TransactionClient) {
  const inputs = await db.product.findMany({
    where: { active: true, type: { isInput: true }, colorId: { not: null } },
    select: {
      typeId: true, groupId: true, colorId: true, quantity: true, currentCost: true, unit: { select: { familyId: true } },
      type: { select: { name: true } }, group: { select: { name: true } }, color: { select: { name: true } },
    },
  });
  const options = new Map<string, ColorKey & { familyId: string; label: string; members: typeof inputs }>();
  for (const input of inputs) {
    const key = { typeId: input.typeId, groupId: input.groupId, colorId: input.colorId! };
    const id = colorKey(key) + '|' + input.unit.familyId;
    const seen = options.get(id);
    options.set(id, seen ? { ...seen, members: [...seen.members, input] } : {
      ...key, familyId: input.unit.familyId, members: [input], label: colorLabel({ type: input.type, group: input.group, color: input.color! }),
    });
  }
  return [...options.values()].map(({ members, ...option }) => ({
    ...option, brands: members.length, averageCost: colorAverage(members.map(member => ({ quantity: member.quantity, value: member.currentCost }))),
  })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Finds the color input, or registers it the first time a recipe uses it. One color never spans two unit families. */
export async function ensureColorInput(tx: Prisma.TransactionClient, color: ColorKey & { familyId: string }) {
  const found = await tx.colorInput.findFirst({ where: { typeId: color.typeId, groupId: color.groupId, colorId: color.colorId }, select: colorLabelSelect });
  if (found && found.familyId !== color.familyId) throw new ConflictException(colorLabel(found) + ' já é medida em outra família de unidades.');
  return found ?? tx.colorInput.create({ data: color, select: colorLabelSelect });
}

const memberSelect = {
  id: true, sku: true, typeId: true, groupId: true, colorId: true, quantity: true, currentCost: true, lastPurchaseExpense: true, unit: { select: { familyId: true } },
} as const satisfies Prisma.ProductSelect;
export type ColorMember = Prisma.ProductGetPayload<{ select: typeof memberSelect }>;
type StoredColor = ColorKey & { id: string; familyId: string };

/** Today's brands of each color, in one query, keyed by the color input. */
export async function colorMembersById(db: Prisma.TransactionClient, colors: StoredColor[]) {
  const unique = [...new Map(colors.map(color => [color.id, color])).values()];
  const members = unique.length ? await db.product.findMany({ where: { OR: unique.map(colorMembers) }, select: memberSelect, orderBy: { sku: 'asc' } }) : [];
  return new Map(unique.map(color => [color.id, members.filter(member => member.unit.familyId === color.familyId
    && colorKey({ typeId: member.typeId, groupId: member.groupId, colorId: member.colorId ?? '' }) === colorKey(color))]));
}

/**
 * A color line as an estimate sees it: one input whose balance is the sum of its brands and whose cost and purchase
 * expense are their averages. A color without brands counts as an inactive input, so it yields nothing.
 */
export function colorLine(members: ColorMember[], reserved: (id: string) => Prisma.Decimal = () => new Prisma.Decimal(0)) {
  return {
    active: members.length > 0, balance: sumValues(members.map(member => member.quantity)), reserved: sumValues(members.map(member => reserved(member.id))),
    unitCost: colorAverage(members.map(member => ({ quantity: member.quantity, value: member.currentCost }))),
    unitExpense: colorAverage(members.map(member => ({ quantity: member.quantity, value: member.lastPurchaseExpense }))),
  };
}
