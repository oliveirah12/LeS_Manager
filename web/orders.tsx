import { useState } from 'react';
import { CheckCircle2, Eye, Play, Plus, Trash2, X } from 'lucide-react';
import { suggestedConsumption } from './format';
import {
  api, Badge, brl, by, dateTime, Field, Form, Loading, message, Modal, ModalForm, notify, PageActions, quantity, Select, sortParam, SortState, Table, Title, useClosePanel, useData,
} from './ui';

type Status = 'PLANNED' | 'PRINTING' | 'DONE' | 'CANCELED';
type OrderItem = {
  productId: string; sku: string; name: string; symbol: string; planned: string;
  good: string | null; lost: string | null; unitCost?: string | null; totalCost?: string | null; lossCost?: string | null;
};
type OrderInput = {
  inputId: string; sku: string; name: string; symbol: string; planned: string; used: string | null;
  parts: { productId: string; planned: string }[];
};
type Order = {
  id: string; number: number; status: Status; notes: string | null; printer: { id: string; name: string }; user: { name: string };
  plannedStart: string; estimatedMinutes: number; expectedEnd: string; startedAt: string | null; finishedAt: string | null; printMinutes: number | null;
  machineCost?: string | null; totalCost?: string | null; lossCost?: string | null; absorbLoss: boolean; items: OrderItem[]; inputs: OrderInput[];
  budget: Budget | null;
};
type Budget = {
  machineCost: string; materialCost: string; totalCost: string; partialCost: boolean; missingCost: string[];
  items: { productId: string; totalCost: string; unitCost: string }[];
};
type OrdersView = { orders: Order[]; page: number; pageSize: number; total: number; printers: { id: string; name: string }[]; products: { id: string; sku: string; name: string; symbol: string }[] };
/** The values only come with stock:view. */
type PreviewItem = { productId: string; sku: string; name: string; symbol: string; good: string; lost: string; unitCost?: string | null; fullUnitCost?: string; lossCost?: string };
type Preview = { printMinutes: number; machineCost?: string; totalCost?: string; lossCost?: string; partialCost?: boolean; items: PreviewItem[] };
type Dialog = { kind: 'new' } | { kind: 'start' | 'finish' | 'cancel' | 'details'; order: Order };

const statuses: Record<Status, { name: string; tone?: 'ok' | 'warn' | 'brand' }> = {
  PLANNED: { name: 'Planejada' }, PRINTING: { name: 'Em impressão', tone: 'brand' }, DONE: { name: 'Concluída', tone: 'ok' }, CANCELED: { name: 'Cancelada', tone: 'warn' },
};
const localValue = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const iso = (value: FormDataEntryValue | null) => new Date(String(value)).toISOString();
const duration = (minutes: number) => (minutes >= 60 ? Math.floor(minutes / 60) + ' h ' : '') + (minutes % 60 ? (minutes % 60) + ' min' : minutes >= 60 ? '' : '0 min');

export function ProductionOrders({ edit, seeCosts }: { edit: boolean; seeCosts: boolean }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(null);
  const query = new URLSearchParams({ page: String(page), ...(sort ? { sort: sortParam(sort)! } : {}) });
  const { data, error, loading, reload } = useData<OrdersView>('production/orders?' + query);
  const [dialog, setDialog] = useState<Dialog>();
  async function done(text: string) {
    notify(text);
    await reload();
  }
  /** A new order is the highest number, so the default view's first page is where it shows up. */
  async function created(text: string) {
    if (page === 1 && !sort) return done(text);
    notify(text);
    setDialog(undefined);
    setPage(1);
    setSort(null);
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const open = (kind: 'start' | 'finish' | 'cancel' | 'details', order: Order) => setDialog({ kind, order });
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} aria-hidden="true" />Nova ordem</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando ordens…" /> : <Table empty="Nenhuma ordem de produção."
      sort={sort} onSort={next => { setSort(next); setPage(1); }}
      footer={pages > 1 && <>
        <span>Página {data.page} de {pages} · {data.total} ordens</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      </>}
      columns={[{ label: 'Ordem', sortKey: 'number' }, 'Produtos', { label: 'Impressora', sortKey: 'printer' }, { label: 'Situação', sortKey: 'status' }, 'Previsão',
        ...(seeCosts ? [{ label: 'Custo', end: true }] : []), { label: 'Ações', actions: true }]}
      rows={data.orders.map(order => [
        <span className="cell-title">#{order.number}</span>,
        <span>{order.items.map(item => quantity(item.planned) + ' ' + item.symbol + ' ' + item.sku).join(' · ')}</span>,
        order.printer.name, <Badge tone={statuses[order.status].tone}>{statuses[order.status].name}</Badge>,
        <span className="muted">{dateTime(order.finishedAt ?? order.expectedEnd)}</span>,
        ...(seeCosts ? [order.budget ? <span title="Estimativa com os custos atuais. Nada é congelado até concluir.">≈ {brl(order.budget.totalCost)}
          <span className="hint" style={{ display: 'block' }}>{order.budget.partialCost ? 'Orçamento parcial' : 'Orçamento'}</span></span> : brl(order.totalCost)] : []),
        <div className="actions">
          <button type="button" className="btn ghost small" aria-label={'Ver ordem ' + order.number} onClick={() => open('details', order)}><Eye size={14} aria-hidden="true" />Ver</button>
          {edit && order.status === 'PLANNED' && <button type="button" className="btn secondary small" onClick={() => open('start', order)}><Play size={14} aria-hidden="true" />Iniciar</button>}
          {edit && order.status === 'PRINTING' && <button type="button" className="btn secondary small" onClick={() => open('finish', order)}><CheckCircle2 size={14} aria-hidden="true" />Concluir</button>}
          {edit && (order.status === 'PLANNED' || order.status === 'PRINTING') &&
            <button type="button" className="btn ghost small" onClick={() => open('cancel', order)}><X size={14} aria-hidden="true" />Cancelar</button>}
        </div>,
      ])} />}

    {data && dialog?.kind === 'new' && <Modal wide title="Nova ordem de produção" close={() => setDialog(undefined)}><NewOrder view={data} done={created} /></Modal>}
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
    {dialog?.kind === 'details' && <Modal wide title={'Ordem #' + dialog.order.number} subtitle={statuses[dialog.order.status].name} close={() => setDialog(undefined)}>
      <OrderDetails order={dialog.order} seeCosts={seeCosts} /></Modal>}
  </>;
}

function InputsTable({ inputs }: { inputs: OrderInput[] }) {
  return <Table responsive={false} columns={['Insumo', { label: 'Previsto', end: true }, ...(inputs.some(input => input.used !== null) ? [{ label: 'Real', end: true }] : [])]}
    rows={inputs.map(input => [
      by(input.name, <Title name={input.name} code={input.sku} />), by(input.planned, quantity(input.planned) + ' ' + input.symbol),
      ...(inputs.some(row => row.used !== null) ? [by(input.used, input.used === null ? '—' : quantity(input.used) + ' ' + input.symbol)] : []),
    ])} />;
}

function NewOrder({ view, done }: { view: OrdersView; done: (text: string) => Promise<void> }) {
  const [rows, setRows] = useState([{ key: 0, productId: '' }]);
  const [plannedStart, setPlannedStart] = useState(() => localValue());
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const closePanel = useClosePanel();
  const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0);
  const validTime = Number.isInteger(estimatedMinutes) && estimatedMinutes > 0;
  const startTime = new Date(plannedStart).getTime();
  const expectedEnd = validTime && Number.isFinite(startTime) ? new Date(startTime + estimatedMinutes * 60000).toISOString() : null;
  if (!view.printers.length || !view.products.length) return <div className="info">
    {!view.printers.length ? 'Cadastre uma impressora ativa em Produção → Impressoras.' : 'Monte a ficha técnica de um produto fabricado em Cadastros → Produtos.'}
  </div>;
  return <Form label="Criar ordem" cancel="Cancelar" action={async values => {
    if (!validTime) throw new Error('Informe o tempo de impressão em horas e minutos inteiros.');
    await api('production/orders', {
      printerId: values.get('printerId'), plannedStart: iso(plannedStart), estimatedMinutes, notes: String(values.get('notes') ?? ''),
      items: rows.map(({ key }) => ({ productId: values.get('product' + key), quantity: values.get('quantity' + key) })),
    });
    await done('Ordem criada.');
    closePanel?.();
  }}>
    <div className="form-grid">
      <Select name="printerId" label="Impressora" options={view.printers} />
      <label>Início previsto<input name="plannedStart" type="datetime-local" required value={plannedStart} onChange={event => setPlannedStart(event.target.value)} /></label>
    </div>
    <div className="form-grid">
      <label>Tempo de impressão (horas)<input name="hours" inputMode="numeric" placeholder="10" value={hours} onChange={event => setHours(event.target.value)} /></label>
      <label>Minutos<input name="minutes" inputMode="numeric" placeholder="0" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
    </div>
    <p className="hint" role="status">{expectedEnd ? <>Término previsto: <strong>{dateTime(expectedEnd)}</strong></> : 'Informe o início e o tempo para calcular o término.'}</p>
    <h3>Produtos da impressão</h3>
    {rows.map(({ key, productId }, index) => {
      const product = view.products.find(item => item.id === productId);
      const options = view.products.filter(item => item.id === productId || !rows.some(row => row.productId === item.id));
      return <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto' }} key={key}>
        <Select name={'product' + key} label={'Produto ' + (index + 1)} options={options.map(item => ({ id: item.id, name: item.sku + ' · ' + item.name }))}
          onChange={value => setRows(items => items.map(item => item.key === key ? { key, productId: value } : item))} />
        <Field name={'quantity' + key} label={'Quantidade' + (product ? ' (' + product.symbol + ')' : '')} inputMode="decimal" />
        <button type="button" className="icon-button" aria-label={'Remover produto ' + (index + 1)} disabled={rows.length === 1}
          onClick={() => setRows(items => items.filter(item => item.key !== key))}><Trash2 size={18} aria-hidden="true" /></button>
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= view.products.length}
      onClick={() => setRows(items => [...items, { key: Math.max(...items.map(item => item.key)) + 1, productId: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar produto</button>
    <Field name="notes" label="Observação" required={false} placeholder="Pedido, cliente ou lote" />
  </Form>;
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
        footer={seeCosts ? <><span>Máquina e energia: {brl(review.preview.machineCost)} · {duration(review.preview.printMinutes)}</span>
          <span>Custo total: <strong>{brl(review.preview.totalCost)}</strong></span></> : <span>Tempo cobrado: {duration(review.preview.printMinutes)}</span>} />
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
      {seeCosts && order.totalCost != null && <div><dt>Custo total</dt><dd>{brl(order.totalCost)}</dd></div>}
      {seeCosts && order.lossCost != null && <div><dt>Valor da perda</dt><dd>{brl(order.lossCost)}{order.absorbLoss ? ' (embutida nas peças boas)' : ''}</dd></div>}
      {order.notes && <div><dt>Observação</dt><dd>{order.notes}</dd></div>}
    </dl>
    {order.budget && <BudgetSummary budget={order.budget} minutes={order.estimatedMinutes} />}
    <Table responsive={false} columns={['Produto', { label: 'Ordem', end: true },
      ...(finished ? [{ label: 'Boas', end: true }, { label: 'Perdidas', end: true }, ...(seeCosts ? [{ label: 'Custo por peça', end: true }] : [])] : []),
      ...(order.budget ? [{ label: 'Total estimado', end: true }, { label: 'Estimado por peça', end: true }] : [])]}
      rows={order.items.map(item => {
        const estimate = order.budget?.items.find(row => row.productId === item.productId);
        return [
          by(item.name, <Title name={item.name} code={item.sku} />), by(item.planned, quantity(item.planned) + ' ' + item.symbol),
          ...(finished ? [by(item.good ?? '0', quantity(item.good ?? '0')), by(item.lost ?? '0', quantity(item.lost ?? '0')), ...(seeCosts ? [by(item.unitCost, brl(item.unitCost))] : [])] : []),
          ...(order.budget ? [by(estimate?.totalCost, '≈ ' + brl(estimate?.totalCost)), by(estimate?.unitCost, '≈ ' + brl(estimate?.unitCost))] : []),
        ];
      })} />
    <InputsTable inputs={order.inputs} />
  </div>;
}

function BudgetSummary({ budget, minutes }: { budget: Budget; minutes: number }) {
  return <>
    <div className="info"><strong>Orçamento estimado.</strong> Usa o custo médio, a impressora e a tarifa de agora. Nada é congelado até a ordem ser concluída.</div>
    {budget.partialCost && <div className="info" role="alert"><strong>Orçamento parcial.</strong> Sem custo registrado: {budget.missingCost.join(', ')}. O total considera apenas os demais insumos.</div>}
    <dl className="dl">
      <div><dt>Insumos previstos</dt><dd>≈ {brl(budget.materialCost)}</dd></div>
      <div><dt>Máquina e energia ({duration(minutes)})</dt><dd>≈ {brl(budget.machineCost)}</dd></div>
      <div><dt>Total estimado</dt><dd><strong>≈ {brl(budget.totalCost)}</strong></dd></div>
    </dl>
  </>;
}
