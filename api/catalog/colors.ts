import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
      typeId: true, groupId: true, colorId: true, unit: { select: { familyId: true } },
      type: { select: { name: true } }, group: { select: { name: true } }, color: { select: { name: true } },
    },
  });
  const options = new Map<string, ColorKey & { familyId: string; label: string; brands: number }>();
  for (const input of inputs) {
    const key = { typeId: input.typeId, groupId: input.groupId, colorId: input.colorId! };
    const id = colorKey(key) + '|' + input.unit.familyId;
    const seen = options.get(id);
    options.set(id, seen ? { ...seen, brands: seen.brands + 1 } : {
      ...key, familyId: input.unit.familyId, brands: 1, label: colorLabel({ type: input.type, group: input.group, color: input.color! }),
    });
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Finds the color input, or registers it the first time a recipe uses it. One color never spans two unit families. */
export async function ensureColorInput(tx: Prisma.TransactionClient, color: ColorKey & { familyId: string }) {
  const found = await tx.colorInput.findFirst({ where: { typeId: color.typeId, groupId: color.groupId, colorId: color.colorId }, select: colorLabelSelect });
  if (found && found.familyId !== color.familyId) throw new ConflictException(colorLabel(found) + ' já é medida em outra família de unidades.');
  return found ?? tx.colorInput.create({ data: color, select: colorLabelSelect });
}
