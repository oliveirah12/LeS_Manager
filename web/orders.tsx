import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Eye, FileText, Pencil, Play, Plus, Wrench, X } from 'lucide-react';
import { decimal, duration, productsSummary, suggestedConsumption } from './format';
import { CorrectOrder, RevisionHistory } from './order-correction';
import { OrderForm } from './order-form';
import { OrderPdf } from './order-pdf';
import {
  api, Badge, brl, by, dateTime, Field, Filters, Form, Loading, message, Modal, ModalForm, notify, PageActions, quantity, SearchInput, Select, sortParam, SortState, Table, Title, useClosePanel, useData,
} from './ui';

type Status = 'PLANNED' | 'PRINTING' | 'DONE' | 'CANCELED';
export type OrderItem = {
  productId: string; sku: string; name: string; symbol: string; planned: string;
  good: string | null; lost: string | null; unitCost?: string | null; totalCost?: string | null; lossCost?: string | null;
  salePrice: string | null; marginPercent?: string | null;
};
type SaleValues = { gross: string; discount: string; total: string; fee: string; net: string; partial: boolean; profit?: string; marginPercent?: string | null };
type Sale = { discountPercent: string; paymentMethodId: string | null; paymentName: string | null; feePercent: string; customFee: boolean; values: SaleValues | null };
export type OrderInput = {
  inputId: string; sku: string; name: string; symbol: string; familyId: string; planned: string; used: string | null;
  parts: { productId: string; planned: string }[]; replaces: string[];
};
export type Order = {
  id: string; number: number; revision: number; status: Status; notes: string | null; printer: { id: string; name: string }; user: { name: string };
  plannedStart: string; estimatedMinutes: number; expectedEnd: string; startedAt: string | null; finishedAt: string | null; printMinutes: number | null;
  powerWatts?: string | null; energyRate?: string | null; hourlyCost?: string | null;
  machineCost?: string | null; totalCost?: string | null; lossCost?: string | null; absorbLoss: boolean; items: OrderItem[]; inputs: OrderInput[];
  budget: Budget | null; sale: Sale; expenses: OrderExpense[]; expenseCost?: string | null;
};
export type OrderExpense = { id: string; source: 'INPUT' | 'MANUAL'; inputId: string | null; title: string; value: string; edited: boolean; suggested: string | null };
type Budget = {
  machineCost: string; expenseCost: string; materialCost: string; totalCost: string; partialCost: boolean; missingCost: string[];
  items: { productId: string; totalCost: string; unitCost: string; suggestedPrice: string | null; belowTargetMargin: boolean }[];
};
export type OrdersView = {
  orders: Order[]; page: number; pageSize: number; total: number; printers: { id: string; name: string }[]; filterPrinters: { id: string; name: string }[];
  paymentMethods: { id: string; name: string; feePercent: string | null }[];
  inputs: { id: string; sku: string; name: string; symbol: string; familyId: string }[];
  products: { id: string; sku: string; name: string; symbol: string; printMinutes?: string | null; salePrice?: string | null; marginPercent?: string | null }[];
};
/** The values only come with stock:view. */
type PreviewItem = { productId: string; sku: string; name: string; symbol: string; good: string; lost: string; unitCost?: string | null; fullUnitCost?: string; lossCost?: string };
type Preview = {
  printMinutes: number; machineCost?: string; expenseCost?: string; totalCost?: string; lossCost?: string; partialCost?: boolean; items: PreviewItem[];
  sale: (SaleValues & { feePercent: string; paymentName: string | null }) | null;
};
type OrderDialog = 'edit' | 'start' | 'finish' | 'cancel' | 'details' | 'correct' | 'pdf';
type Dialog = { kind: 'new' } | { kind: OrderDialog; order: Order };

const statuses: Record<Status, { name: string; tone?: 'ok' | 'warn' | 'brand' }> = {
  PLANNED: { name: 'Planejada' }, PRINTING: { name: 'Em impressão', tone: 'brand' }, DONE: { name: 'Concluída', tone: 'ok' }, CANCELED: { name: 'Cancelada', tone: 'warn' },
};
const statusOptions = (Object.keys(statuses) as Status[]).map(id => ({ id, name: statuses[id].name }));
const newestFirst = { key: 'start', direction: 'desc' } as const;
const localValue = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const iso = (value: FormDataEntryValue | null) => new Date(String(value)).toISOString();

/** A short line that opens, in place, what each product of the order is. */
function OrderProducts({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  return <div className={'order-products' + (open ? ' open' : '')}>
    <button type="button" className="order-products-toggle" aria-expanded={open} aria-controls={list}
      aria-label={(open ? 'Ocultar' : 'Mostrar') + ' produtos da ordem ' + order.number + ': ' + productsSummary(order.items)} onClick={() => setOpen(!open)}>
      <span>{productsSummary(order.items)}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    <ul id={list} hidden={!open}>
      {order.items.map(item => <li key={item.productId}>
        <Title name={item.name} code={item.sku} />
        <span className="order-product-values">
          <span>{quantity(item.planned)} {item.symbol}</span>
          <span>Preço: {item.salePrice === null ? '—' : brl(item.salePrice)}</span>
          {item.good !== null && <span>Boas: {quantity(item.good)}</span>}
          {item.lost !== null && <span>Perdidas: {quantity(item.lost)}</span>}
        </span>
      </li>)}
    </ul>
  </div>;
}

/** The next step of the order keeps its name, and the rest are icons in fixed places so the rows line up. */
function OrderActions({ order, edit, correct, open }: {
  order: Order; edit: boolean; correct: boolean; open: (kind: OrderDialog, order: Order) => void;
}) {
  const next = edit && order.status === 'PLANNED' ? { kind: 'start', label: 'Iniciar', Icon: Play } as const
    : edit && order.status === 'PRINTING' ? { kind: 'finish', label: 'Concluir', Icon: CheckCircle2 } as const
    : correct && order.status === 'DONE' ? { kind: 'correct', label: 'Corrigir', Icon: Wrench } as const : null;
  const cancelable = edit && (order.status === 'PLANNED' || order.status === 'PRINTING');
  const side = (kind: 'details' | 'pdf' | 'edit' | 'cancel', label: string, Icon: typeof Eye) => <button type="button" className={'btn ghost small order-action ' + kind} title={label}
    aria-label={label + ' ordem ' + order.number} onClick={() => open(kind, order)}><Icon size={16} aria-hidden="true" /><span className="order-action-label">{label}</span></button>;
  return <div className="order-actions">
    {next && <button type="button" className="btn secondary small order-action-next" aria-label={next.label + ' ordem ' + order.number} onClick={() => open(next.kind, order)}>
      <next.Icon size={15} aria-hidden="true" />{next.label}</button>}
    {side('details', 'Ver', Eye)}
    {side('pdf', 'PDF', FileText)}
    {edit && order.status === 'PLANNED' && side('edit', 'Editar', Pencil)}
    {cancelable && side('cancel', 'Cancelar', X)}
  </div>;
}

export function ProductionOrders({ edit, correct, seeCosts }: { edit: boolean; correct: boolean; seeCosts: boolean }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(newestFirst);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filtersForm, setFiltersForm] = useState(0);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  // Waits for a pause in the typing, so the server is not asked once per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed.trim() === search) return;
      setSearch(typed.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, search]);
  const query = new URLSearchParams({ page: String(page), sort: sortParam(sort)!, ...filters, ...(search ? { search } : {}) });
  const { data, error, loading, reload } = useData<OrdersView>('production/orders?' + query);
  // The list reloads with each filter, and the form must stay on screen with what was typed.
  const printerOptions = useRef<OrdersView['filterPrinters']>([]);
  if (data) printerOptions.current = data.filterPrinters;
  const applyFilters = (values: Record<string, string>) => {
    setFilters(Object.fromEntries(Object.entries(values).filter(([, value]) => value)));
    setPage(1);
  };
  const [dialog, setDialog] = useState<Dialog>();
  async function done(text: string) {
    notify(text);
    await reload();
  }
  /** Returns to the default view, where the newest starts are on the first page. */
  async function created(text: string) {
    if (page === 1 && sort?.key === newestFirst.key && sort.direction === newestFirst.direction && !Object.keys(filters).length && !typed) return done(text);
    notify(text);
    setDialog(undefined);
    setPage(1);
    setSort(newestFirst);
    setFilters({});
    setFiltersForm(version => version + 1);
    setTyped('');
    setSearch('');
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const open = (kind: OrderDialog, order: Order) => setDialog({ kind, order });
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} aria-hidden="true" />Nova ordem</button></PageActions>}
    <div className="toolbar"><SearchInput value={typed} onChange={setTyped} label="Buscar ordens" placeholder="Buscar por produto, SKU ou nº da ordem" /></div>
    <Filters key={filtersForm} active={Object.keys(filters).length} apply={applyFilters} clear={() => applyFilters({})}>
      <Select name="status" label="Situação" required={false} placeholder="Todas" options={statusOptions} />
      <Select name="printerId" label="Impressora" required={false} placeholder="Todas" options={printerOptions.current} />
      <Field name="from" label="Início de" type="date" required={false} />
      <Field name="to" label="Início até" type="date" required={false} />
    </Filters>
    {message(error)}
    {!data ? loading && <Loading label="Carregando ordens…" /> : <Table empty={search || Object.keys(filters).length ? 'Nenhuma ordem encontrada.' : 'Nenhuma ordem de produção.'}
      sort={sort} onSort={next => { setSort(next ?? (sort?.key === newestFirst.key ? { key: newestFirst.key, direction: 'asc' } : newestFirst)); setPage(1); }}
      footer={pages > 1 && <>
        <span>Página {data.page} de {pages} · {data.total} ordens</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      </>}
      columns={[{ label: 'Ordem', sortKey: 'number' }, 'Produtos', { label: 'Impressora', sortKey: 'printer' }, { label: 'Situação', sortKey: 'status' }, { label: 'Início', sortKey: 'start' }, 'Previsão',
        ...(seeCosts ? [{ label: 'Custo', end: true }] : []), { label: 'Ações', actions: true }]}
      rows={data.orders.map(order => [
        <span className="cell-title">#{order.number}</span>,
        <OrderProducts key={order.id} order={order} />,
        order.printer.name, <Badge tone={statuses[order.status].tone}>{statuses[order.status].name}</Badge>,
        <span className="muted">{dateTime(order.startedAt ?? order.plannedStart)}</span>,
        <span className="muted">{dateTime(order.finishedAt ?? order.expectedEnd)}</span>,
        ...(seeCosts ? [order.budget ? <span title="Estimativa com os custos atuais. Nada é congelado até concluir.">≈ {brl(order.budget.totalCost)}
          <span className="hint" style={{ display: 'block' }}>{order.budget.partialCost ? 'Orçamento parcial' : 'Orçamento'}</span></span> : brl(order.totalCost)] : []),
        <OrderActions order={order} edit={edit} correct={correct} open={open} />,
      ])} />}

    {data && dialog?.kind === 'new' && <Modal wide title="Nova ordem de produção" close={() => setDialog(undefined)}><OrderForm view={data} seeCosts={seeCosts} done={created} /></Modal>}
    {data && dialog?.kind === 'edit' && <Modal wide title={'Editar ordem #' + dialog.order.number} subtitle="Nada muda no estoque até a impressão começar." close={() => setDialog(undefined)}>
      <OrderForm view={data} order={dialog.order} seeCosts={seeCosts} done={done} /></Modal>}
    {dialog?.kind === 'start' && <ModalForm title={'Iniciar ordem #' + dialog.order.number} subtitle="Os insumos ficam reservados até a conclusão." label="Iniciar impressão"
      close={() => setDialog(undefined)} action={async values => {
        await api('production/orders/' + dialog.order.id + '/start', { startedAt: iso(values.get('startedAt')) });
        await done('Impressão iniciada.');
      }}>
      <Field name="startedAt" label="Início real" type="datetime-local" defaultValue={localValue()} />
      <InputsTable inputs={dialog.order.inputs} />
    </ModalForm>}
    {dialog?.kind === 'finish' && <Modal wide title={'Concluir ordem #' + dialog.order.number} close={() => setDialog(undefined)}>
      <FinishOrder order={dialog.order} seeCosts={seeCosts} done={done} /></Modal>}
    {dialog?.kind === 'cancel' && <ModalForm title={'Cancelar ordem #' + dialog.order.number} label="Cancelar ordem" cancel="Voltar" danger close={() => setDialog(undefined)}
      action={async values => {
        const inputs = dialog.order.status === 'PRINTING'
          ? dialog.order.inputs.map(input => ({ inputId: input.inputId, used: String(values.get('used' + input.inputId) || '0') })) : [];
        await api('production/orders/' + dialog.order.id + '/cancel', { inputs });
        await done('Ordem cancelada.');
      }}>
      {dialog.order.status === 'PRINTING' ? <>
        <p className="muted">Informe quanto foi gasto até aqui. Só isso sai do estoque, e o restante da reserva é liberado.</p>
        {dialog.order.inputs.map(input => <Field key={input.inputId} name={'used' + input.inputId} label={input.sku + ' gasto (' + input.symbol + ')'}
          inputMode="decimal" required={false} placeholder="0" hint={'Reservado: ' + quantity(input.planned) + ' ' + input.symbol} />)}
      </> : <p className="muted">A ordem ainda não iniciou, então nada muda no estoque.</p>}
    </ModalForm>}
    {data && dialog?.kind === 'correct' && <Modal wide title={'Corrigir ordem #' + dialog.order.number} subtitle="Correção técnica auditada de uma ordem concluída." close={() => setDialog(undefined)}>
      <CorrectOrder order={dialog.order} view={data} seeCosts={seeCosts} done={done} /></Modal>}
    {dialog?.kind === 'details' && <Modal wide title={'Ordem #' + dialog.order.number} subtitle={statuses[dialog.order.status].name} close={() => setDialog(undefined)}>
      <OrderDetails order={dialog.order} seeCosts={seeCosts} /></Modal>}
    {dialog?.kind === 'pdf' && <OrderPdf order={dialog.order} statusName={statuses[dialog.order.status].name} seeCosts={seeCosts} close={() => setDialog(undefined)} />}
  </>;
}

function InputsTable({ inputs }: { inputs: OrderInput[] }) {
  return <Table responsive={false} columns={['Insumo', { label: 'Previsto', end: true }, ...(inputs.some(input => input.used !== null) ? [{ label: 'Real', end: true }] : [])]}
    rows={inputs.map(input => [
      by(input.name, <><Title name={input.name} code={input.sku} />{input.replaces.length > 0 && <span className="hint" style={{ display: 'block' }}>Substitui {input.replaces.join(', ')}</span>}</>),
      by(input.planned, quantity(input.planned) + ' ' + input.symbol),
      ...(inputs.some(row => row.used !== null) ? [by(input.used, input.used === null ? '—' : quantity(input.used) + ' ' + input.symbol)] : []),
    ])} />;
}

function FinishOrder({ order, seeCosts, done }: { order: Order; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [review, setReview] = useState<{ payload: Record<string, unknown>; preview: Preview; absorb: boolean; shipOut: boolean }>();
  const [lostPieces, setLostPieces] = useState<Record<string, string>>({});
  const [printed, setPrinted] = useState<Record<string, string>>({});
  const [typedUse, setTypedUse] = useState<Record<string, string>>({});
  const closePanel = useClosePanel();
  const path = 'production/orders/' + order.id;
  const lost = review?.preview.items.filter(item => Number(item.lost) > 0) ?? [];
  const hasLoss = (productId: string) => Number((lostPieces[productId] ?? '').replace(',', '.')) > 0;
  const lossItems = order.items.map(item => ({
    productId: item.productId, planned: item.planned, lost: lostPieces[item.productId] ?? '', printedPercent: printed[item.productId] ?? '',
  }));
  const clearTyped = (inputId: string) => setTypedUse(({ [inputId]: _removed, ...others }) => others);
  return <>
    <div hidden={!!review}>
      <Form label={seeCosts ? 'Conferir custos' : 'Conferir conclusão'} cancel="Cancelar" action={async values => {
        const minutes = String(values.get('printMinutes') ?? '').trim();
        const payload = {
          finishedAt: iso(values.get('finishedAt')), absorbLoss: values.has('absorbLoss'), shipOut: values.has('shipOut'),
          ...(minutes ? { printMinutes: Number(minutes) } : {}),
          items: order.items.map(item => ({ productId: item.productId, lost: String(values.get('lost' + item.productId) || '0') })),
          inputs: order.inputs.map(input => ({ inputId: input.inputId, used: String(values.get('used' + input.inputId) || input.planned) })),
        };
        const preview = await api<Preview>(path + '/preview', payload);
        setReview({ payload, preview, absorb: payload.absorbLoss, shipOut: payload.shipOut });
      }}>
        <div className="form-grid">
          <Field name="finishedAt" label="Término real" type="datetime-local" defaultValue={localValue()} />
          <Field name="printMinutes" label="Tempo cobrado (min)" inputMode="numeric" required={false} hint="Vazio: diferença entre início e término." />
        </div>
        <h3>Peças perdidas (opcional)</h3>
        {order.items.map(item => <div className="form-grid" key={item.productId}>
          <label>{item.sku} ({item.symbol})
            <input name={'lost' + item.productId} inputMode="decimal" placeholder="0" value={lostPieces[item.productId] ?? ''}
              onChange={event => setLostPieces(values => ({ ...values, [item.productId]: event.target.value }))} />
            <span className="hint">De {quantity(item.planned)} {item.symbol}</span></label>
          {hasLoss(item.productId) && <label>Quanto da peça perdida foi impresso (%)
            <input name={'printed' + item.productId} inputMode="decimal" placeholder="100" value={printed[item.productId] ?? ''}
              onChange={event => setPrinted(values => ({ ...values, [item.productId]: event.target.value }))} />
            <span className="hint">Vazio: gastou todo o material da peça.</span></label>}
        </div>)}
        <h3>Consumo real</h3>
        <div className="form-grid">{order.inputs.map(input => {
          const suggested = suggestedConsumption(input.planned, input.parts, lossItems);
          const typed = typedUse[input.inputId];
          return <div className="stack" style={{ gap: 6 }} key={input.inputId}>
            <label>{input.sku} ({input.symbol})
              <input name={'used' + input.inputId} inputMode="decimal" required value={typed ?? suggested}
                onChange={event => setTypedUse(values => ({ ...values, [input.inputId]: event.target.value }))} /></label>
            {typed !== undefined && typed !== suggested
              ? <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => clearTyped(input.inputId)}>
                Usar sugestão: {quantity(suggested)} {input.symbol}</button>
              : <span className="hint">{suggested === input.planned ? 'Previsto' : 'Sugerido pela perda. Previsto'}: {quantity(input.planned)} {input.symbol}</span>}
          </div>;
        })}</div>
        <label className="check"><input name="absorbLoss" type="checkbox" />Embutir a perda no custo das peças boas</label>
        <label className="check"><input name="shipOut" type="checkbox" />Produzir e já dar saída (encomenda)</label>
      </Form>
    </div>
    {review && <div className="stack">
      {review.preview.partialCost && <div className="info">Há insumo sem custo registrado, então o custo considera apenas os demais.</div>}
      {lost.length > 0 && !seeCosts && <div className="info">{review.absorb ? 'A perda será embutida no custo das peças boas.' : 'As peças boas mantêm o custo normal, e a perda fica registrada na ordem.'}</div>}
      {lost.length > 0 && seeCosts && (review.absorb
        ? <div className="info" role="alert"><strong>A perda será embutida no custo.</strong> {lost.map(item => item.sku + ' passa de ' + brl(item.fullUnitCost) + ' para ' +
          (item.unitCost === null ? '— (nenhuma peça boa)' : brl(item.unitCost)) + ' por ' + item.symbol).join('; ')}. Isso aumenta o custo médio em estoque.</div>
        : <div className="info">As peças boas mantêm o custo normal. A perda de <strong>{brl(review.preview.lossCost)}</strong> fica registrada na ordem.</div>)}
      <Table columns={['Produto', { label: 'Boas', end: true }, { label: 'Perdidas', end: true },
        ...(seeCosts ? [{ label: 'Custo por peça', end: true }, { label: 'Valor da perda', end: true }] : [])]}
        rows={review.preview.items.map(item => [
          by(item.name, <Title name={item.name} code={item.sku} />), by(item.good, quantity(item.good) + ' ' + item.symbol), by(item.lost, quantity(item.lost) + ' ' + item.symbol),
          ...(seeCosts ? [by(item.unitCost, <strong>{brl(item.unitCost)}</strong>), by(item.lossCost, brl(item.lossCost))] : []),
        ])}
        footer={seeCosts ? <><span>Máquina e energia: {brl(review.preview.machineCost)} · {duration(review.preview.printMinutes)} · Despesas: {brl(review.preview.expenseCost)}</span>
          <span>Custo total: <strong>{brl(review.preview.totalCost)}</strong></span></> : <span>Tempo cobrado: {duration(review.preview.printMinutes)}</span>} />
      {review.preview.sale && <SaleSummary sale={review.preview.sale} paymentName={review.preview.sale.paymentName} feePercent={review.preview.sale.feePercent} seeCosts={seeCosts} />}
      {review.shipOut && <p className="hint">As peças boas entram e saem do estoque na mesma operação.</p>}
      <Form label="Confirmar conclusão" extra={<button type="button" className="btn secondary" onClick={() => setReview(undefined)}>Voltar</button>} action={async () => {
        await api(path + '/finish', review.payload);
        await done('Ordem concluída.');
        closePanel?.();
      }} />
    </div>}
  </>;
}

function OrderDetails({ order, seeCosts }: { order: Order; seeCosts: boolean }) {
  const finished = order.items.some(item => item.good !== null);
  return <div className="stack">
    <dl className="dl">
      <div><dt>Impressora</dt><dd>{order.printer.name}</dd></div>
      <div><dt>Criada por</dt><dd>{order.user.name}</dd></div>
      <div><dt>Início previsto</dt><dd>{dateTime(order.plannedStart)}</dd></div>
      <div><dt>Término previsto</dt><dd>{dateTime(order.expectedEnd)}</dd></div>
      <div><dt>Tempo estimado</dt><dd>{duration(order.estimatedMinutes)}</dd></div>
      {order.startedAt && <div><dt>Início real</dt><dd>{dateTime(order.startedAt)}</dd></div>}
      {order.finishedAt && <div><dt>Encerrada em</dt><dd>{dateTime(order.finishedAt)}</dd></div>}
      {order.printMinutes !== null && <div><dt>Tempo cobrado</dt><dd>{duration(order.printMinutes)}</dd></div>}
      {seeCosts && order.machineCost != null && <div><dt>Máquina e energia</dt><dd>{brl(order.machineCost)}</dd></div>}
      {seeCosts && order.expenseCost != null && <div><dt>Despesas</dt><dd>{brl(order.expenseCost)}</dd></div>}
      {seeCosts && order.totalCost != null && <div><dt>Custo total</dt><dd>{brl(order.totalCost)}</dd></div>}
      {seeCosts && order.lossCost != null && <div><dt>Valor da perda</dt><dd>{brl(order.lossCost)}{order.absorbLoss ? ' (embutida nas peças boas)' : ''}</dd></div>}
      {order.notes && <div><dt>Observação</dt><dd>{order.notes}</dd></div>}
    </dl>
    {order.budget && <BudgetSummary budget={order.budget} minutes={order.estimatedMinutes} />}
    {order.sale.values && <SaleSummary sale={order.sale.values} paymentName={order.sale.paymentName} feePercent={order.sale.feePercent} seeCosts={seeCosts} />}
    <Table responsive={false} columns={['Produto', { label: 'Ordem', end: true },
      ...(finished ? [{ label: 'Boas', end: true }, { label: 'Perdidas', end: true }, ...(seeCosts ? [{ label: 'Custo por peça', end: true }] : [])] : []),
      { label: 'Preço', end: true },
      ...(order.budget ? [{ label: 'Total estimado', end: true }, { label: 'Estimado por peça', end: true }, { label: 'Preço sugerido', end: true }] : [])]}
      rows={order.items.map(item => {
        const estimate = order.budget?.items.find(row => row.productId === item.productId);
        return [
          by(item.name, <Title name={item.name} code={item.sku} />), by(item.planned, quantity(item.planned) + ' ' + item.symbol),
          ...(finished ? [by(item.good ?? '0', quantity(item.good ?? '0')), by(item.lost ?? '0', quantity(item.lost ?? '0')), ...(seeCosts ? [by(item.unitCost, brl(item.unitCost))] : [])] : []),
          by(item.salePrice, item.salePrice === null ? '—' : brl(item.salePrice)),
          ...(order.budget ? [by(estimate?.totalCost, '≈ ' + brl(estimate?.totalCost)), by(estimate?.unitCost, '≈ ' + brl(estimate?.unitCost)),
            by(estimate?.suggestedPrice, <span title={estimate?.belowTargetMargin ? 'O preço confirmado está abaixo da margem desejada.' : undefined}>
              {estimate?.suggestedPrice ? brl(estimate.suggestedPrice) : '—'}{estimate?.belowTargetMargin ? ' ⚠' : ''}</span>)] : []),
        ];
      })} />
    <InputsTable inputs={order.inputs} />
    {order.expenses.length > 0 && <Table responsive={false} columns={['Despesa', 'Origem', { label: 'Valor', end: true }]}
      rows={order.expenses.map(row => [row.title, row.source === 'INPUT' ? (row.edited ? 'Insumo (editada)' : 'Insumo') : 'Manual', by(row.value, brl(row.value))])} />}
    {order.revision > 0 && <RevisionHistory orderId={order.id} seeCosts={seeCosts} />}
  </div>;
}

function SaleSummary({ sale, paymentName, feePercent, seeCosts }: { sale: SaleValues; paymentName: string | null; feePercent: string; seeCosts: boolean }) {
  return <>
    <h3>Venda</h3>
    {sale.partial && <div className="info">Há item sem preço, então a venda considera apenas os demais.</div>}
    <dl className="dl">
      <div><dt>Bruto</dt><dd>{brl(sale.gross)}</dd></div>
      <div><dt>Desconto</dt><dd>{brl(sale.discount)}</dd></div>
      <div><dt>Total da venda</dt><dd>{brl(sale.total)}</dd></div>
      <div><dt>Pagamento</dt><dd>{paymentName ?? '—'}</dd></div>
      <div><dt>Taxa ({decimal(feePercent)}%)</dt><dd>{brl(sale.fee)}</dd></div>
      <div><dt>Líquido</dt><dd><strong>{brl(sale.net)}</strong></dd></div>
      {seeCosts && sale.profit !== undefined && <div><dt>Resultado</dt><dd>{brl(sale.profit)}{sale.marginPercent != null ? ' · ' + decimal(sale.marginPercent) + '%' : ''}</dd></div>}
    </dl>
  </>;
}

function BudgetSummary({ budget, minutes }: { budget: Budget; minutes: number }) {
  return <>
    <div className="info"><strong>Orçamento estimado.</strong> Usa o custo médio, a impressora e a tarifa de agora. Nada é congelado até a ordem ser concluída.</div>
    {budget.partialCost && <div className="info" role="alert"><strong>Orçamento parcial.</strong> Sem custo registrado: {budget.missingCost.join(', ')}. O total considera apenas os demais insumos.</div>}
    <dl className="dl">
      <div><dt>Insumos previstos</dt><dd>≈ {brl(budget.materialCost)}</dd></div>
      <div><dt>Máquina e energia ({duration(minutes)})</dt><dd>≈ {brl(budget.machineCost)}</dd></div>
      <div><dt>Despesas</dt><dd>≈ {brl(budget.expenseCost)}</dd></div>
      <div><dt>Total estimado</dt><dd><strong>≈ {brl(budget.totalCost)}</strong></dd></div>
    </dl>
  </>;
}
