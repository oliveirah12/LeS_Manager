import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { type LinkedCost, PricingBase, PricingDraft, pricingBlock, pricingDraft, PricingFields, pricingPayload, PricingView } from './pricing';
import { ProductFiles } from './product-files';
import { ProductImageField } from './product-image';
import { recipeCost, RecipeDraft, recipeDraft, RecipeFields, recipePath, recipePayload, RecipeView } from './recipe';
import { referenceKinds, RegistrationData } from './registrations';
import { api, Field, fields, Form, Loading, message, Product, Select, unitOptions, useClosePanel, useData } from './ui';

export type MeasureRow = { key: number; name: string; value: string; unit: string };
export const measureRows = (product?: Product | null): MeasureRow[] => (product?.measures ?? []).map((row, key) => ({ ...row, key }));

/** Technical part of the product payload. An empty field clears the stored value. */
export function technicalPayload(input: Record<string, string>, rows: MeasureRow[]) {
  return {
    lengthMm: input.lengthMm || null, widthMm: input.widthMm || null, heightMm: input.heightMm || null, diameterMm: input.diameterMm || null,
    purchaseUrl: input.purchaseUrl?.trim() || null,
    measures: rows.map(({ key }) => ({ name: input['measureName' + key], value: input['measureValue' + key], unit: input['measureUnit' + key] })),
  };
}

export function TechnicalFields({ product, rows, setRows }: {
  product?: Product | null; rows: MeasureRow[]; setRows: (update: (rows: MeasureRow[]) => MeasureRow[]) => void;
}) {
  const dimension = (name: 'lengthMm' | 'widthMm' | 'heightMm' | 'diameterMm', label: string) =>
    <Field name={name} label={label} inputMode="decimal" required={false} defaultValue={product?.[name] ?? undefined} />;
  return <>
    <div className="form-grid">
      {dimension('lengthMm', 'Comprimento (mm)')}
      {dimension('widthMm', 'Largura (mm)')}
      {dimension('heightMm', 'Altura (mm)')}
      {dimension('diameterMm', 'Diâmetro (mm)')}
    </div>
    <Field name="purchaseUrl" label="URL de compra" type="url" required={false} placeholder="https://" defaultValue={product?.purchaseUrl ?? undefined} />
    {rows.map((row, index) => <div className="component-row" key={row.key}>
      <Field name={'measureName' + row.key} label={'Medida ' + (index + 1)} placeholder="Ex.: Passo da rosca" defaultValue={row.name} />
      <Field name={'measureValue' + row.key} label="Valor" inputMode="decimal" defaultValue={row.value} />
      <Field name={'measureUnit' + row.key} label="Unidade" placeholder="mm" defaultValue={row.unit} />
      <button type="button" className="icon-button" aria-label={'Remover medida ' + (index + 1)}
        onClick={() => setRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }}
      onClick={() => setRows(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, name: '', value: '', unit: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar medida</button>
  </>;
}

/**
 * One form and one save for the whole product: registry, image and files, recipe and price. New files go up first,
 * then the product goes with everything in one call, and the API saves it all or nothing.
 */
export function ProductForm({ data, product, editStock, save, changed }: {
  data: RegistrationData; product: Product | null; editStock: boolean; save: (body: unknown) => Promise<void>; changed: () => Promise<void>;
}) {
  const [measures, setMeasures] = useState(() => measureRows(product));
  const [typeId, setTypeId] = useState(product?.typeId ?? data.productTypes.find(type => type.isDefault)?.id ?? '');
  const [unitId, setUnitId] = useState(product?.unit.id ?? '');
  const [image, setImage] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  // A retry after a failed save reuses what already went up: the API keeps unlinked uploads pending for an hour.
  const sent = useRef(new Map<File, string>());
  const closePanel = useClosePanel();
  const manufactured = !!data.productTypes.find(type => type.id === typeId)?.isManufactured;
  const recipeView = useData<RecipeView>(manufactured ? recipePath(product?.id) : null);
  const pricingView = useData<PricingView | { options: LinkedCost[] }>(editStock ? (product ? 'stock/products/' + product.id + '/pricing' : 'stock/pricing-options') : null);
  // Each part is sent only when the person changed it, so an unrelated edit never trips on an old recipe or price.
  const [recipe, setRecipe] = useState<{ draft: RecipeDraft; changed: boolean }>();
  const [pricing, setPricing] = useState<{ draft: PricingDraft; changed: boolean }>();
  useEffect(() => {
    const view = recipeView.data;
    if (view) setRecipe(current => current ?? { draft: recipeDraft(view), changed: false });
  }, [recipeView.data]);
  useEffect(() => {
    const view = pricingView.data;
    if (view) setPricing(current => current ?? { draft: pricingDraft('id' in view ? view : undefined), changed: false });
  }, [pricingView.data]);

  const chosen = data.units.find(unit => unit.id === unitId);
  const symbol = data.units.find(unit => unit.familyId === chosen?.familyId && unit.isBase)?.symbol ?? chosen?.symbol ?? 'un';
  const saved = pricingView.data && 'id' in pricingView.data ? pricingView.data : undefined;
  const estimate = manufactured && recipeView.data && recipe?.draft.rows.length ? recipeCost(recipeView.data, recipe.draft, data.units) : null;
  // Display only, like the price panel of a saved product: the API never stores this estimate.
  const base: PricingBase = estimate && recipe && recipeView.data ? {
    symbol, source: 'RECIPE', materialCost: estimate.material.toFixed(6), partialCost: estimate.partial, machineCost: estimate.machine?.toFixed(6) ?? null,
    printMinutes: recipe.draft.minutes || null, printer: recipeView.data.printers.find(printer => printer.id === recipe.draft.printerId) ?? null,
    baseCost: (estimate.material + (estimate.machine ?? 0)).toFixed(6),
  } : {
    symbol, source: 'AVERAGE', materialCost: null, partialCost: false, machineCost: null, printMinutes: null, printer: null,
    baseCost: saved?.source === 'AVERAGE' ? saved.baseCost : null,
  };

  async function upload(kind: 'image' | 'file', file: File) {
    const known = sent.current.get(file);
    if (known) return known;
    const body = new FormData();
    body.append('file', file);
    const stored = await api<{ id: string }>('catalog/uploads/' + kind, body);
    sent.current.set(file, stored.id);
    return stored.id;
  }

  return <Form label={product ? 'Salvar produto' : 'Cadastrar produto'} cancel="Cancelar" action={async values => {
    const input = fields(values);
    const commercial = editStock && pricing?.changed ? pricing.draft : null;
    const block = commercial && pricingBlock(commercial);
    if (block) throw new Error(block);
    const imageFileId = image ? await upload('image', image) : undefined;
    const fileIds: string[] = [];
    for (const file of files) fileIds.push(await upload('file', file));
    await save({
      sku: input.sku, name: input.name, typeId: input.typeId, unitId: input.unitId,
      ...Object.fromEntries(referenceKinds.map(kind => [kind.field, input[kind.field] || null])),
      ...technicalPayload(input, measures),
      ...(imageFileId ? { imageFileId } : {}), ...(fileIds.length ? { fileIds } : {}),
      ...(manufactured && recipe?.changed ? { recipe: recipePayload(recipe.draft) } : {}),
      ...(commercial ? { commercial: pricingPayload(commercial) } : {}),
    });
    closePanel?.();
  }}>
    <h3>Dados</h3>
    <Field name="sku" label="SKU" placeholder="Ex.: CX-KRAFT-2020" defaultValue={product?.sku} />
    <Field name="name" label="Nome do produto" defaultValue={product?.name} />
    <Select name="typeId" label="Tipo" options={data.productTypes} defaultValue={typeId} onChange={setTypeId} />
    <Select name="unitId" label="Unidade" defaultValue={product?.unit.id} onChange={setUnitId}
      options={unitOptions(product?.deleteBlock ? data.units.filter(unit => unit.familyId === product.unit.familyId) : data.units)} />
    {product?.deleteBlock && <p className="hint">Como este produto já tem histórico, só aceita unidades da mesma família.</p>}
    <div className="form-grid">
      {referenceKinds.map(kind => <Select key={kind.id} name={kind.field} label={kind.name} required={false}
        defaultValue={product?.[kind.field] ?? undefined} options={data.references.filter(item => item.kind === kind.id)} />)}
    </div>
    <TechnicalFields product={product} rows={measures} setRows={setMeasures} />

    <h3>Imagem e arquivos</h3>
    <ProductImageField product={product ?? undefined} name={product?.name ?? ''} pending={image} choose={setImage} changed={changed} />
    <ProductFiles productId={product?.id} edit={{ files, change: setFiles, changed }} />

    {manufactured && <section className="preview-box">
      <div className="section-head"><h3>Ficha técnica</h3></div>
      {message(recipeView.error)}
      {!recipeView.data || !recipe ? recipeView.loading && <Loading label="Carregando ficha técnica…" />
        : <RecipeFields view={recipeView.data} draft={recipe.draft} units={data.units} symbol={symbol} name={product?.name ?? ''}
          change={update => setRecipe(current => current && { draft: update(current.draft), changed: true })} />}
    </section>}

    {editStock && <section className="preview-box">
      <div className="section-head"><h3>Formação de preço</h3></div>
      {message(pricingView.error)}
      {!pricingView.data || !pricing ? pricingView.loading && <Loading label="Carregando formação de preço…" />
        : <PricingFields base={base} options={pricingView.data.options} draft={pricing.draft}
          change={update => setPricing(current => current && { draft: update(current.draft), changed: true })} />}
    </section>}
  </Form>;
}
