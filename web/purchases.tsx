import { useState } from 'react';
import { Eye, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { CostItem, costModes, costValue } from './costs';
import { PurchaseAttachments } from './purchase-documents';
import {
  api, Badge, brl, by, dateTime, Field, fields, Loading, message, Modal, ModalForm, notify, PageActions, Product, productOptions, quantity, Select, Table, Title, today, Unit, unitOptions, useData,
} from './ui';

type Row = {
  id: string; number: number; purchaseDate: string; documentNumber: string | null; goodsTotal: string; costsTotal: string; converted: boolean; reversedAt: string | null;
  supplier: { name: string } | null; user: { name: string }; _count: { items: number };
};
type Page = { purchases: Row[]; nextCursor: string | null };
type Options = { suppliers: { id: string; name: string }[]; products: Product[]; units: Unit[]; costs: Pick<CostItem, 'id' | 'name' | 'mode' | 'value'>[] };
type CostRow = { key: number; costItemId: string; title: string; mode: string; value: string; filled: number };
type Details = Omit<Row, 'supplier' | '_count'> & {
  supplierId: string | null; supplier: { id: string; name: string } | null; notes: string | null; createdAt: string; reversalReason: string | null; reversedBy: { name: string } | null;
  reversalBlock: string | null;
  costs: { id: string; title: string; mode: 'VALUE' | 'PERCENT'; value: string; split: 'VALUE' | 'QUANTITY'; amount: string }[];
  items: {
    id: string; sku: string; name: string; symbol: string; declaredQuantity: string; declaredUnit: string; quantity: string; goodsTotal: string; unitCost: string | null;
    expenseTotal: string; unitExpense: string; shares: { amount: string; cost: { title: string } }[];
  }[];
};
type Dialog = { kind: 'new' } | { kind: 'view' | 'edit' | 'reverse'; id: string };
const splits = [{ id: 'VALUE', name: 'Por valor' }, { id: 'QUANTITY', name: 'Por quantidade' }];
const shortDate = (value: string) => new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
const typed = (value: string) => { const number = Number(value.replace(',', '.')); return Number.isFinite(number) ? number : 0; };

function Status({ row }: { row: Pick<Row, 'reversedAt' | 'converted'> }) {
  if (row.reversedAt) return <Badge tone="danger">Estornada</Badge>;
  return row.converted ? <Badge>Convertida</Badge> : <Badge tone="ok">Lançada</Badge>;
}

export function Purchases({ edit }: { edit: boolean }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const list = useData<Page>('purchases' + (cursor ? '?cursor=' + cursor : ''));
  const [dialog, setDialog] = useState<Dialog>();
  const close = () => setDialog(undefined);
  const saved = async (text: string) => { notify(text); await list.reload(); };
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} aria-hidden="true" />Nova compra</button></PageActions>}
    {message(list.error)}
    {!list.data ? list.loading && <Loading label="Carregando compras…" /> : <Table empty="Nenhuma compra registrada."
      columns={[{ label: 'Nº', end: true }, 'Data', 'Fornecedor', 'Documento', { label: 'Itens', end: true }, { label: 'Mercadorias', end: true }, { label: 'Custos adicionais', end: true }, 'Situação', { label: 'Ações', actions: true }]}
      rows={list.data.purchases.map(row => [
        by(row.number, <span className="num">{row.number}</span>), by(row.purchaseDate, shortDate(row.purchaseDate)), by(row.supplier?.name, row.supplier?.name ?? '—'),
        by(row.documentNumber, row.documentNumber ?? '—'), by(row._count.items, <span className="num">{row._count.items}</span>),
        by(row.goodsTotal, <strong>{brl(row.goodsTotal)}</strong>), by(row.costsTotal, brl(row.costsTotal)),
        by(row.reversedAt ? 'Estornada' : row.converted ? 'Convertida' : 'Lançada', <Status row={row} />),
        <button type="button" className="btn secondary small" aria-label={'Ver compra ' + row.number} onClick={() => setDialog({ kind: 'view', id: row.id })}><Eye size={14} aria-hidden="true" />Ver</button>,
      ])}
      footer={(cursor || list.data.nextCursor) && <>
        <span>Página {cursors.length + 1}</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={!cursor} onClick={() => setCursors(cursors.slice(0, -1))}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={!list.data.nextCursor} onClick={() => setCursors([...cursors, list.data!.nextCursor!])}>Próxima</button>
        </div>
      </>} />}
    {edit && dialog?.kind === 'new' && <NewPurchase close={close} saved={saved} />}
    {dialog && dialog.kind !== 'new' && <PurchaseDialog key={dialog.id + dialog.kind} dialog={dialog} edit={edit} setDialog={setDialog} close={close} saved={saved} />}
  </>;
}

function NewPurchase({ close, saved }: { close: () => void; saved: (text: string) => Promise<void> }) {
  const { data, error } = useData<Options>('purchases/options');
  const [items, setItems] = useState([{ key: 0, productId: '', total: '' }]);
  const [costs, setCosts] = useState<CostRow[]>([]);
  if (!data) return <Modal wide title="Nova compra" close={close}>{message(error)}{!error && <Loading label="Carregando…" />}</Modal>;
  const patchItem = (key: number, patch: Partial<typeof items[number]>) => setItems(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  const patchCost = (key: number, patch: Partial<CostRow>) => setCosts(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  // A registered cost fills a copy of its values. They stay editable, and the purchase keeps what was typed.
  const pickCost = (row: CostRow, costItemId: string) => {
    const cost = data.costs.find(item => item.id === costItemId);
    patchCost(row.key, cost ? { costItemId, title: cost.name, mode: cost.mode, value: cost.value, filled: row.filled + 1 } : { costItemId: '' });
  };
  const goods = items.reduce((total, row) => total + typed(row.total), 0);
  const extra = costs.reduce((total, row) => total + (row.mode === 'PERCENT' ? goods * typed(row.value) / 100 : typed(row.value)), 0);
  const manufactured = items.flatMap(row => { const product = data.products.find(item => item.id === row.productId); return product?.type?.isManufactured ? [product.sku] : []; });
  return <ModalForm wide title="Nova compra" subtitle="O estoque e o custo médio mudam ao lançar. A data é informativa." label="Lançar compra" close={close} action={async values => {
    const input = fields(values);
    await api('purchases', {
      supplierId: input.supplierId, documentNumber: input.documentNumber, purchaseDate: input.purchaseDate, notes: input.notes,
      items: items.map(({ key }) => ({ productId: input['product' + key], unitId: input['unit' + key], quantity: input['quantity' + key], totalCost: input['total' + key] })),
      costs: costs.map(({ key, costItemId }) => ({ costItemId: costItemId || null, title: input['title' + key], mode: input['mode' + key], value: input['value' + key], split: input['split' + key] })),
      ...(manufactured.length ? { acknowledgeNoInputs: values.has('acknowledgeNoInputs') } : {}),
    });
    await saved('Compra lançada.');
  }}>
    <div className="form-grid">
      <Select name="supplierId" label="Fornecedor" required={false} placeholder="Sem fornecedor" options={data.suppliers} />
      <Field name="documentNumber" label="Nº do documento" required={false} />
      <Field name="purchaseDate" label="Data da compra" type="date" defaultValue={today()} />
      <Field name="notes" label="Observações" required={false} />
    </div>
    <h3>Itens</h3>
    {items.map(({ key, productId, total }, index) => {
      const product = data.products.find(item => item.id === productId);
      return <div className="component-row purchase-row" key={key}>
        <Select name={'product' + key} label={'Produto ' + (index + 1)} options={productOptions(data.products)} onChange={value => patchItem(key, { productId: value })} />
        <Field name={'quantity' + key} label="Quantidade" inputMode="decimal" />
        <Select key={productId} name={'unit' + key} label="Unidade" defaultValue={product?.unit.id}
          options={unitOptions(data.units.filter(unit => unit.familyId === product?.unit.familyId))} />
        <label>Total da mercadoria (R$)<input name={'total' + key} inputMode="decimal" required value={total} onChange={event => patchItem(key, { total: event.target.value })} /></label>
        {items.length > 1 && <button type="button" className="btn ghost small" aria-label={'Remover produto ' + (index + 1)} onClick={() => setItems(items.filter(row => row.key !== key))}><Trash2 size={14} aria-hidden="true" /></button>}
      </div>;
    })}
    <div><button type="button" className="btn secondary small" onClick={() => setItems([...items, { key: Math.max(...items.map(row => row.key)) + 1, productId: '', total: '' }])}>
      <Plus size={14} aria-hidden="true" />Adicionar item</button></div>
    <h3>Custos adicionais</h3>
    <p className="hint">Frete, taxas e outras despesas ficam fora do custo médio e aparecem nos valores da última compra. O percentual vale sobre o total das mercadorias.</p>
    {costs.map((row, index) => { const { key, costItemId, title, mode, value, filled } = row; return <div className="component-row cost-row" key={key}>
      <Select name={'costItem' + key} label={'Custo cadastrado ' + (index + 1)} required={false} placeholder="Digitar manualmente" defaultValue={costItemId}
        options={data.costs.map(cost => ({ id: cost.id, name: cost.name + ' · ' + costValue(cost) }))} onChange={next => pickCost(row, next)} />
      <label>Título<input name={'title' + key} required maxLength={160} placeholder="Frete" value={title} onChange={event => patchCost(key, { title: event.target.value })} /></label>
      <Select key={filled} name={'mode' + key} label="Tipo" defaultValue={mode} options={costModes} onChange={next => patchCost(key, { mode: next })} />
      <label>{mode === 'PERCENT' ? 'Percentual' : 'Valor (R$)'}<input name={'value' + key} inputMode="decimal" required value={value} onChange={event => patchCost(key, { value: event.target.value })} /></label>
      <Select name={'split' + key} label="Rateio" defaultValue="VALUE" options={splits} />
      <button type="button" className="btn ghost small" aria-label={'Remover custo ' + (index + 1)} onClick={() => setCosts(costs.filter(item => item.key !== key))}><Trash2 size={14} aria-hidden="true" /></button>
    </div>; })}
    <div><button type="button" className="btn secondary small" onClick={() => setCosts([...costs, { key: Math.max(0, ...costs.map(row => row.key)) + 1, costItemId: '', title: '', mode: 'VALUE', value: '', filled: 0 }])}>
      <Plus size={14} aria-hidden="true" />Adicionar custo</button></div>
    <p className="summary">Mercadorias <strong className="num">{brl(goods)}</strong> · custos adicionais <strong className="num">{brl(extra)}</strong> · total <strong className="num">{brl(goods + extra)}</strong></p>
    {manufactured.length > 0 && <div className="info stack" role="alert" style={{ gap: 8 }}>
      <span><strong>Esta entrada não baixa filamento nem outros insumos de {manufactured.join(', ')}.</strong> Para produzir consumindo o estoque, use Produção → Ordens.</span>
      <label className="check"><input name="acknowledgeNoInputs" type="checkbox" required />Estou ciente e quero registrar mesmo assim</label>
    </div>}
  </ModalForm>;
}

function PurchaseDialog({ dialog, edit, setDialog, close, saved }: {
  dialog: { kind: 'view' | 'edit' | 'reverse'; id: string }; edit: boolean; setDialog: (dialog: Dialog) => void; close: () => void; saved: (text: string) => Promise<void>;
}) {
  const { data, error } = useData<Details>('purchases/' + dialog.id);
  const options = useData<Options>(edit && dialog.kind === 'edit' ? 'purchases/options' : null);
  const title = 'Compra nº ' + (data?.number ?? '…');
  if (!data) return <Modal wide title={title} close={close}>{message(error)}{!error && <Loading label="Carregando compra…" />}</Modal>;
  if (edit && dialog.kind === 'edit') {
    if (!options.data) return <Modal title={title} close={close}>{message(options.error)}{!options.error && <Loading label="Carregando…" />}</Modal>;
    // An inactive supplier stays selectable on the purchase that already uses it.
    const suppliers = data.supplier && !options.data.suppliers.some(row => row.id === data.supplier!.id) ? [data.supplier, ...options.data.suppliers] : options.data.suppliers;
    return <ModalForm title={'Editar ' + title.toLowerCase()} subtitle="Quantidade e custo só mudam por estorno." label="Salvar" close={close} action={async values => {
      const { supplierId, documentNumber, purchaseDate, notes } = fields(values);
      await api('purchases/' + data.id, { supplierId, documentNumber, purchaseDate, notes }, 'PATCH');
      await saved('Compra alterada.');
    }}>
      <Select name="supplierId" label="Fornecedor" required={false} placeholder="Sem fornecedor" defaultValue={data.supplierId ?? undefined} options={suppliers} />
      <Field name="documentNumber" label="Nº do documento" required={false} defaultValue={data.documentNumber ?? undefined} />
      <Field name="purchaseDate" label="Data da compra" type="date" defaultValue={data.purchaseDate.slice(0, 10)} />
      <Field name="notes" label="Observações" required={false} defaultValue={data.notes ?? undefined} />
    </ModalForm>;
  }
  if (edit && dialog.kind === 'reverse') return <ModalForm danger title={'Estornar ' + title.toLowerCase()} label="Confirmar estorno" close={close} action={async values => {
    await api('purchases/' + data.id + '/reversal', { reason: values.get('reason') });
    await saved('Compra estornada.');
  }}>
    <p className="muted">A quantidade sai do estoque, e o custo médio e os valores da última compra voltam ao que eram antes desta compra.</p>
    <Field name="reason" label="Motivo" placeholder="Nota lançada com valor errado" />
  </ModalForm>;
  return <Modal wide title={title} subtitle={shortDate(data.purchaseDate) + (data.supplier ? ' · ' + data.supplier.name : '')} close={close}>
    <div className="stack">
      <dl className="dl">
        <div><dt>Situação</dt><dd><Status row={data} /></dd></div>
        <div><dt>Documento</dt><dd>{data.documentNumber ?? '—'}</dd></div>
        <div><dt>Lançada</dt><dd>{dateTime(data.createdAt)} · {data.user.name}</dd></div>
        <div><dt>Mercadorias</dt><dd>{brl(data.goodsTotal)}</dd></div>
        <div><dt>Custos adicionais</dt><dd>{brl(data.costsTotal)}</dd></div>
        {data.notes && <div><dt>Observações</dt><dd>{data.notes}</dd></div>}
        {data.reversedAt && <div><dt>Estorno</dt><dd>{dateTime(data.reversedAt)} · {data.reversedBy?.name} · {data.reversalReason}</dd></div>}
      </dl>
      <Table columns={['Produto', { label: 'Quantidade', end: true }, { label: 'Mercadoria', end: true }, { label: 'Custo unitário', end: true }, { label: 'Despesas', end: true }, { label: 'Despesa unitária', end: true }]}
        rows={data.items.map(item => [
          by(item.name, <Title name={item.name} code={item.sku} />), by(item.quantity, quantity(item.declaredQuantity) + ' ' + item.declaredUnit),
          by(item.goodsTotal, brl(item.goodsTotal)), by(item.unitCost, item.unitCost === null ? '—' : brl(item.unitCost) + ' / ' + item.symbol),
          by(item.expenseTotal, <span title={item.shares.map(share => share.cost.title + ': ' + brl(share.amount)).join(' · ') || undefined}>{brl(item.expenseTotal)}</span>),
          by(item.unitExpense, brl(item.unitExpense) + ' / ' + item.symbol),
        ])} />
      {data.costs.length > 0 && <Table columns={['Custo', 'Tipo', 'Rateio', { label: 'Valor', end: true }]}
        rows={data.costs.map(cost => [
          cost.title, cost.mode === 'PERCENT' ? quantity(cost.value) + '%' : 'Valor', cost.split === 'VALUE' ? 'Por valor' : 'Por quantidade', by(cost.amount, brl(cost.amount)),
        ])} />}
      <PurchaseAttachments purchaseId={data.id} edit={edit} />
      {edit && !data.reversedAt && <div className="form-actions">
        <button type="button" className="btn secondary" onClick={() => setDialog({ kind: 'edit', id: data.id })}><Pencil size={16} aria-hidden="true" />Editar dados</button>
        <button type="button" className={'btn secondary' + (data.reversalBlock ? ' unavailable' : '')} disabled={!!data.reversalBlock} title={data.reversalBlock ?? undefined}
          onClick={() => setDialog({ kind: 'reverse', id: data.id })}><Undo2 size={16} aria-hidden="true" />Estornar</button>
      </div>}
      {edit && !data.reversedAt && data.reversalBlock && <p className="hint">Estorno indisponível: {data.reversalBlock}</p>}
    </div>
  </Modal>;
}
