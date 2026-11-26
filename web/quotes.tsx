import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Eye, FileText, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { companyBrand, type Company } from './company';
import { decimal, duration, productsSummary } from './format';
import { loadReportImage } from './pdf';
import { PdfViewer } from './pdf-viewer';
import { QuoteForm } from './quote-form';
import { quoteReport } from './quote-report';
import type { Quote, QuoteAction, QuoteStatus, QuotesView } from './quote-types';
import { StartPicker } from './start-picker';
import {
  api, Badge, brl, by, dateTime, displayDate, Field, Filters, Loading, message, Modal, ModalForm, notify, PageActions, quantity, SearchInput, Select, sortParam, SortState, Table, Title, useData,
} from './ui';

const statuses: Record<QuoteStatus, { name: string; tone?: 'ok' | 'warn' | 'brand' | 'danger' }> = {
  DRAFT: { name: 'Rascunho' }, SENT: { name: 'Enviado', tone: 'brand' }, APPROVED: { name: 'Aprovado', tone: 'ok' }, REJECTED: { name: 'Recusado', tone: 'warn' },
};
const statusOptions = (Object.keys(statuses) as QuoteStatus[]).map(id => ({ id, name: statuses[id].name }));
const newestFirst = { key: 'number', direction: 'desc' } as const;
type QuoteDialog = Exclude<QuoteAction, 'edit'> | 'edit' | 'details' | 'pdf';
type Dialog = { kind: 'new' } | { kind: QuoteDialog; quote: Quote };
const summary = (quote: Quote) => productsSummary(quote.items.map(item => ({ sku: item.sku, symbol: item.symbol, planned: item.quantity })));

/** The next step keeps its name, and the rest are icons in fixed places so the rows line up. */
function QuoteActions({ quote, edit, approve, open }: { quote: Quote; edit: boolean; approve: boolean; open: (kind: QuoteDialog, quote: Quote) => void }) {
  const can = (action: QuoteAction) => edit && quote.actions.includes(action) && (action !== 'approve' || approve);
  const next = quote.status === 'DRAFT' && can('send') ? { kind: 'send', label: 'Enviar', Icon: Send } as const
    : can('approve') ? { kind: 'approve', label: 'Aprovar', Icon: CheckCircle2 } as const : null;
  const side = (kind: QuoteDialog, label: string, Icon: typeof Eye) => <button type="button" className={'btn ghost small order-action ' + kind} title={label}
    aria-label={label + ' orçamento ' + quote.number} onClick={() => open(kind, quote)}><Icon size={16} aria-hidden="true" /><span className="order-action-label">{label}</span></button>;
  return <div className="order-actions">
    {next && <button type="button" className="btn secondary small order-action-next" aria-label={next.label + ' orçamento ' + quote.number} onClick={() => open(next.kind, quote)}>
      <next.Icon size={15} aria-hidden="true" />{next.label}</button>}
    {side('details', 'Ver', Eye)}
    {side('pdf', 'PDF', FileText)}
    {can('edit') && side('edit', 'Editar', Pencil)}
    {can('reject') && side('reject', 'Recusar', X)}
    {can('delete') && side('delete', 'Excluir', Trash2)}
  </div>;
}

export function Quotes({ edit, approve, seeCosts }: { edit: boolean; approve: boolean; seeCosts: boolean }) {
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
  const { data, error, loading, reload } = useData<QuotesView>('quotes?' + query);
  const [dialog, setDialog] = useState<Dialog>();
  const applyFilters = (values: Record<string, string>) => {
    setFilters(Object.fromEntries(Object.entries(values).filter(([, value]) => value)));
    setPage(1);
  };
  async function done(text: string) {
    notify(text);
    await reload();
  }
  /** Returns to the default view, where the newest quote is on the first page. */
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
  const open = (kind: QuoteDialog, quote: Quote) => setDialog({ kind, quote });
  const close = () => setDialog(undefined);
  const decide = (quote: Quote, action: 'send' | 'reject', text: string) => async () => {
    await api('quotes/' + quote.id + '/' + action, {});
    await done(text);
  };
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} aria-hidden="true" />Novo orçamento</button></PageActions>}
    <div className="toolbar"><SearchInput value={typed} onChange={setTyped} label="Buscar orçamentos" placeholder="Buscar por cliente, título, produto ou nº" /></div>
    <Filters key={filtersForm} active={Object.keys(filters).length} apply={applyFilters} clear={() => applyFilters({})}>
      <Select name="status" label="Situação" required={false} placeholder="Todas" options={statusOptions} />
      <Field name="from" label="Criado de" type="date" required={false} />
      <Field name="to" label="Criado até" type="date" required={false} />
    </Filters>
    {message(error)}
    {!data ? loading && <Loading label="Carregando orçamentos…" /> : <Table empty={search || Object.keys(filters).length ? 'Nenhum orçamento encontrado.' : 'Nenhum orçamento.'}
      sort={sort} onSort={next => { setSort(next ?? (sort?.key === newestFirst.key ? { key: newestFirst.key, direction: 'asc' } : newestFirst)); setPage(1); }}
      footer={pages > 1 && <>
        <span>Página {data.page} de {pages} · {data.total} orçamentos</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      </>}
      columns={[{ label: 'Orçamento', sortKey: 'number' }, { label: 'Cliente', sortKey: 'customer' }, 'Produtos', { label: 'Situação', sortKey: 'status' },
        { label: 'Validade', sortKey: 'validUntil' }, { label: 'Total', end: true }, ...(seeCosts ? [{ label: 'Custo', end: true }] : []), { label: 'Ações', actions: true }]}
      rows={data.quotes.map(quote => [
        <span className="cell-title">#{quote.number}</span>,
        <span><strong>{quote.customerName}</strong><span className="hint" style={{ display: 'block' }}>{quote.title}</span></span>,
        <span className="muted">{summary(quote)}</span>,
        <span><Badge tone={statuses[quote.status].tone}>{statuses[quote.status].name}</Badge>
          {quote.productionOrder && <span className="hint" style={{ display: 'block' }}>Ordem #{quote.productionOrder.number}</span>}</span>,
        <span className="muted">{displayDate(quote.validUntil)}{quote.expired && quote.actions.includes('approve') &&
          <span className="hint" style={{ display: 'block' }}>Vencido</span>}</span>,
        brl(quote.sale?.total),
        ...(seeCosts ? [quote.budget ? <span title="Estimativa com os custos atuais.">≈ {brl(quote.budget.totalCost)}</span> : '—'] : []),
        <QuoteActions quote={quote} edit={edit} approve={approve} open={open} />,
      ])} />}

    {data && dialog?.kind === 'new' && <Modal wide title="Novo orçamento" close={close}><QuoteForm view={data} seeCosts={seeCosts} done={created} /></Modal>}
    {data && dialog?.kind === 'edit' && <Modal wide title={'Editar orçamento #' + dialog.quote.number} subtitle={statuses[dialog.quote.status].name} close={close}>
      <QuoteForm view={data} quote={dialog.quote} seeCosts={seeCosts} done={done} /></Modal>}
    {dialog?.kind === 'details' && <Modal wide title={'Orçamento #' + dialog.quote.number} subtitle={statuses[dialog.quote.status].name} close={close}>
      <QuoteDetails quote={dialog.quote} seeCosts={seeCosts} /></Modal>}
    {dialog?.kind === 'pdf' && <QuotePdf quote={dialog.quote} close={close} />}
    {dialog?.kind === 'send' && <ModalForm title={'Enviar orçamento #' + dialog.quote.number} label="Marcar como enviado" close={close}
      action={decide(dialog.quote, 'send', 'Orçamento marcado como enviado.')}>
      <p className="muted">Gere o PDF e envie ao cliente pelo canal de sempre. Aqui o orçamento passa a constar como enviado e continua editável.</p>
    </ModalForm>}
    {dialog?.kind === 'reject' && <ModalForm title={'Recusar orçamento #' + dialog.quote.number} label="Recusar orçamento" cancel="Voltar" danger close={close}
      action={decide(dialog.quote, 'reject', 'Orçamento recusado.')}>
      <p className="muted">O orçamento deixa de ser editável. Depois de recusado, ele pode ser excluído.</p>
    </ModalForm>}
    {dialog?.kind === 'delete' && <ModalForm title={'Excluir orçamento #' + dialog.quote.number} label="Excluir orçamento" cancel="Voltar" danger close={close}
      action={async () => {
        await api('quotes/' + dialog.quote.id, undefined, 'DELETE');
        await done('Orçamento excluído.');
      }}>
      <p className="muted">O orçamento recusado de {dialog.quote.customerName} será apagado. A exclusão fica registrada na auditoria.</p>
    </ModalForm>}
    {dialog?.kind === 'approve' && <ApproveQuote quote={dialog.quote} close={close} done={done} />}
  </>;
}

/** Approving books the printer, so it asks for the start in the same calendar as the orders. */
function ApproveQuote({ quote, close, done }: { quote: Quote; close: () => void; done: (text: string) => Promise<void> }) {
  const [plannedStart, setPlannedStart] = useState('');
  const [blocked, setBlocked] = useState('');
  return <ModalForm wide title={'Aprovar orçamento #' + quote.number} subtitle="Gera uma ordem de produção planejada com os itens, preços, desconto e despesas." label="Aprovar e criar ordem"
    close={close} action={async () => {
      if (!plannedStart) throw new Error('Escolha o dia e o horário de início.');
      if (blocked) throw new Error(blocked);
      const approved = await api<Quote>('quotes/' + quote.id + '/approve', { plannedStart: new Date(plannedStart).toISOString() });
      await done('Orçamento aprovado. Ordem #' + approved.productionOrder?.number + ' criada em Produção › Ordens.');
    }}>
    <dl className="dl">
      <div><dt>Impressora</dt><dd>{quote.printer.name}</dd></div>
      <div><dt>Tempo estimado</dt><dd>{duration(quote.estimatedMinutes)}</dd></div>
      <div><dt>Produtos</dt><dd>{summary(quote)}</dd></div>
    </dl>
    {quote.expired && <div className="info">A validade deste orçamento terminou em {displayDate(quote.validUntil)}. Confira os preços antes de aprovar.</div>}
    <StartPicker printerId={quote.printer.id} minutes={quote.estimatedMinutes} value={plannedStart} onChange={setPlannedStart} onBlocked={setBlocked} keepValue={false} />
  </ModalForm>;
}

/** The customer's PDF reads the letterhead and the product image through quotes:view routes, so a seller never needs the registrations. */
function QuotePdf({ quote, close }: { quote: Quote; close: () => void }) {
  const build = useCallback(async () => {
    const company = await api<Company>('quotes/letterhead');
    const logo = company.logoFileId ? '/api/quotes/letterhead/logo?v=' + company.logoFileId : null;
    const pictured = quote.items.find(item => item.imageFileId);
    const [brand, image] = await Promise.all([
      companyBrand(company, logo),
      pictured ? loadReportImage('/api/quotes/products/' + pictured.productId + '/image?v=' + pictured.imageFileId) : null,
    ]);
    return quoteReport(quote, { brand, footer: company.footer }, image);
  }, [quote]);
  return <PdfViewer title={'PDF do orçamento #' + quote.number} subtitle={quote.customerName} fileName={'orcamento-' + quote.number + '.pdf'} build={build} close={close} />;
}

function QuoteDetails({ quote, seeCosts }: { quote: Quote; seeCosts: boolean }) {
  const budget = seeCosts ? quote.budget : null;
  return <div className="stack">
    <dl className="dl">
      <div><dt>Cliente</dt><dd>{quote.customerName}</dd></div>
      {quote.customerContact && <div><dt>Contato</dt><dd>{quote.customerContact}</dd></div>}
      <div><dt>Título</dt><dd>{quote.title}</dd></div>
      {quote.description && <div><dt>Descrição</dt><dd>{quote.description}</dd></div>}
      {quote.details.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      <div><dt>Impressora</dt><dd>{quote.printer.name}</dd></div>
      <div><dt>Tempo estimado</dt><dd>{quote.printPlates ? quote.printPlates + (quote.printPlates === 1 ? ' placa · ' : ' placas · ') : ''}{duration(quote.estimatedMinutes)}</dd></div>
      {quote.deliveryDays && <div><dt>Prazo de entrega</dt><dd>{quote.deliveryDays} {quote.deliveryDays === 1 ? 'dia' : 'dias'}</dd></div>}
      <div><dt>Válido até</dt><dd>{displayDate(quote.validUntil)}{quote.expired && quote.actions.includes('approve') ? ' (vencido)' : ''}</dd></div>
      <div><dt>Criado por</dt><dd>{quote.user.name} · {dateTime(quote.createdAt)}</dd></div>
      {quote.sentAt && <div><dt>Enviado em</dt><dd>{dateTime(quote.sentAt)}</dd></div>}
      {quote.decidedAt && <div><dt>{quote.status === 'APPROVED' ? 'Aprovado em' : 'Recusado em'}</dt><dd>{dateTime(quote.decidedAt)}</dd></div>}
      {quote.productionOrder && <div><dt>Ordem de produção</dt><dd>#{quote.productionOrder.number}</dd></div>}
      {quote.notes && <div><dt>Observação interna</dt><dd>{quote.notes}</dd></div>}
    </dl>
    {budget && <>
      <div className="info"><strong>Custo estimado.</strong> Usa o custo médio dos insumos, a impressora e a tarifa de agora, como o orçamento da ordem planejada.</div>
      {budget.partialCost && <div className="info" role="alert"><strong>Custo parcial.</strong> Sem custo registrado: {budget.missingCost.join(', ')}.</div>}
      <dl className="dl">
        <div><dt>Insumos</dt><dd>≈ {brl(budget.materialCost)}</dd></div>
        <div><dt>Máquina e energia</dt><dd>≈ {brl(budget.machineCost)}</dd></div>
        <div><dt>Despesas</dt><dd>≈ {brl(budget.expenseCost)}</dd></div>
        <div><dt>Custo de produção</dt><dd><strong>≈ {brl(budget.totalCost)}</strong></dd></div>
      </dl>
    </>}
    <Table responsive={false} columns={['Produto', { label: 'Quantidade', end: true }, { label: 'Preço', end: true }, { label: 'Total', end: true },
      ...(budget ? [{ label: 'Custo por peça', end: true }, { label: 'Preço sugerido', end: true }, { label: 'Margem real', end: true }] : [])]}
      rows={quote.items.map(item => {
        const estimate = budget?.items.find(row => row.productId === item.productId);
        return [
          by(item.name, <Title name={item.name} code={item.sku} />), by(item.quantity, quantity(item.quantity) + ' ' + item.symbol), by(item.salePrice, brl(item.salePrice)), by(item.total, brl(item.total)),
          ...(budget ? [
            by(estimate?.pricedCost, '≈ ' + brl(estimate?.pricedCost)),
            by(estimate?.suggestedPrice, estimate?.suggestedPrice ? brl(estimate.suggestedPrice) : '—'),
            by(estimate?.realMargin, <span title={estimate?.belowTargetMargin ? 'O preço está abaixo da margem desejada.' : undefined}>
              {estimate?.realMargin == null ? '—' : decimal(estimate.realMargin) + '%'}{estimate?.belowTargetMargin ? ' ⚠' : ''}</span>),
          ] : []),
        ];
      })} />
    {quote.expenses.length > 0 && <Table responsive={false} columns={['Despesa', { label: 'Valor', end: true }]}
      rows={quote.expenses.map(row => [row.title, by(row.value, brl(row.value))])} />}
    {quote.sale && <>
      <h3>Venda</h3>
      <dl className="dl">
        <div><dt>Bruto</dt><dd>{brl(quote.sale.gross)}</dd></div>
        <div><dt>Desconto ({decimal(quote.discountPercent)}%)</dt><dd>{brl(quote.sale.discount)}</dd></div>
        <div><dt>Total ao cliente</dt><dd><strong>{brl(quote.sale.total)}</strong></dd></div>
        <div><dt>Pagamento</dt><dd>{quote.paymentName ?? '—'}</dd></div>
        <div><dt>Taxa ({decimal(quote.feePercent)}%)</dt><dd>{brl(quote.sale.fee)}</dd></div>
        <div><dt>Líquido</dt><dd>{brl(quote.sale.net)}</dd></div>
        {seeCosts && quote.sale.profit !== undefined && <div><dt>Resultado</dt><dd>{brl(quote.sale.profit)}{quote.sale.marginPercent != null ? ' · ' + decimal(quote.sale.marginPercent) + '%' : ''}</dd></div>}
      </dl>
    </>}
  </div>;
}
