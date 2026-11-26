import { Body, Controller, ForbiddenException, Inject, Injectable, Param, Patch, Post, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit, auditChange } from '../audit/recorder';
import { FileService } from '../files/files';
import { Database, idField, parse, serial } from '../shared';
import { CatalogService, catalogProduct, productFields, productUpdate } from './catalog';
import { applySettings, stockSettingsFields } from './pricing';
import { applyRecipe, recipeFields } from './recipe';

/** What the product form saves together with the registry: files sent before, the recipe and the price. */
const productParts = {
  imageFileId: idField.optional(),
  fileIds: z.array(idField).max(20).refine(ids => new Set(ids).size === ids.length, 'Envie cada arquivo apenas uma vez.').optional(),
  commercial: stockSettingsFields.optional(),
  recipe: recipeFields.optional(),
};
export const productCreate = productFields.extend(productParts);
export const productChange = productUpdate.extend(productParts);
type Parts = Pick<z.infer<typeof productCreate>, keyof typeof productParts>;

@Injectable()
export class ProductService {
  constructor(@Inject(Database) private db: Database, @Inject(CatalogService) private catalog: CatalogService, @Inject(FileService) private files: FileService) {}

  /** Registry, files, recipe and price share one transaction: if any part fails, nothing is saved. */
  create(data: z.infer<typeof productCreate>, authorId: string) {
    const { imageFileId, fileIds, commercial, recipe, ...fields } = data;
    return serial(this.db, async tx => {
      const { id } = await this.catalog.createProduct(tx, fields);
      await this.saveParts(tx, id, { imageFileId, fileIds, commercial, recipe }, authorId, true);
      return tx.product.findUniqueOrThrow({ where: { id }, select: catalogProduct });
    });
  }

  async update(id: string, data: z.infer<typeof productChange>, authorId: string) {
    const { imageFileId, fileIds, commercial, recipe, ...fields } = data;
    const { product, replaced } = await serial(this.db, async tx => {
      await this.catalog.updateProduct(tx, id, fields);
      const replaced = await this.saveParts(tx, id, { imageFileId, fileIds, commercial, recipe }, authorId, false);
      return { product: await tx.product.findUniqueOrThrow({ where: { id }, select: catalogProduct }), replaced };
    });
    // The replaced image leaves the disk only after the commit, as in the image route.
    if (replaced) await this.files.purge([replaced]);
    return product;
  }

  /** Each part adds its readable values to the single audit record of the save. A new product has no "before". */
  private async saveParts(tx: Prisma.TransactionClient, id: string, parts: Parts, authorId: string, created: boolean) {
    const audit = (before: Record<string, unknown>, after: Record<string, unknown>) => auditChange(created ? null : before, after);
    let replaced: string | null = null;
    if (parts.imageFileId) {
      const image = await this.files.linkProductImage(tx, id, parts.imageFileId, authorId);
      audit({ Imagem: image.before }, { Imagem: image.after });
      replaced = image.replaced;
    }
    if (parts.fileIds?.length) {
      const files = await this.files.linkProductFiles(tx, id, parts.fileIds, authorId);
      audit({ Arquivos: files.before }, { Arquivos: files.after });
    }
    if (parts.recipe) {
      const recipe = await applyRecipe(tx, id, parts.recipe);
      audit(recipe.before, recipe.after);
    }
    if (parts.commercial) {
      const settings = await applySettings(tx, id, parts.commercial);
      audit(settings.before, settings.after);
    }
    return replaced;
  }
}

/** The price keeps its own permission. The recipe needs catalog:operate, which every product save already requires. */
function allowParts(permissions: string[], data: Parts) {
  if (data.commercial && !canAccess(permissions, 'stock:operate')) throw new ForbiddenException('Seu perfil não tem acesso ao preço e ao estoque.');
}

@Controller('catalog/products')
export class ProductController {
  constructor(@Inject(ProductService) private products: ProductService) {}

  @Require('catalog:operate')
  @Audit('Criar produto')
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) {
    const data = parse(productCreate, body);
    allowParts(request.identity.permissions, data);
    return this.products.create(data, request.identity.id);
  }

  @Require('catalog:operate')
  @Audit('Alterar produto')
  @Patch(':id')
  update(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(productChange, body);
    allowParts(request.identity.permissions, data);
    return this.products.update(parse(idField, id), data, request.identity.id);
  }
}
