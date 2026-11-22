import { ChangeEvent, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { fileSize } from './format';
import {
  api, Badge, by, dateTime, Field, Filters, Loading, message, notify, Select, sortParam, SortState, Table, useData,
} from './ui';

type DocumentType = 'INVOICE' | 'RECEIPT' | 'PAYMENT_PROOF' | 'QUOTE' | 'OTHER';
type PurchaseFile = { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string; author: string; type: DocumentType };
type Found = PurchaseFile & {
  purchase: { id: string; number: number; purchaseDate: string; documentNumber: string | null; converted: boolean; reversedAt: string | null; supplier: { name: string } | null };
};
type SearchPage = { documents: Found[]; total: number; page: number; pageSize: number };
type Options = { suppliers: { id: string; name: string }[]; products: { id: string; name: string }[] };

const typeLabels: Record<DocumentType, string> = {
  INVOICE: 'Nota fiscal', RECEIPT: 'Recibo', PAYMENT_PROOF: 'Comprovante de pagamento', QUOTE: 'Orçamento', OTHER: 'Outro',
};
const typeOptions = (Object.entries(typeLabels) as [DocumentType, string][]).map(([id, name]) => ({ id, name }));
const maxBytes = 20 * 1024 * 1024;
const accepted = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.xml';
const shortDate = (value: string) => new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
const fileRoute = (purchaseId: string, fileId: string) => 'purchases/' + purchaseId + '/documents/' + fileId;

/** Download for everyone who sees the file, and removal with a confirmation for those who operate purchases. */
function FileActions({ purchaseId, file, edit, busy, removed }: {
  purchaseId: string; file: PurchaseFile; edit: boolean; busy: boolean; removed: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) return <div className="actions">
    <button type="button" className="btn danger small" disabled={busy} onClick={() => void removed().finally(() => setConfirming(false))}>Confirmar exclusão</button>
    <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
  </div>;
  return <div className="actions">
    <a className="btn secondary small" href={'/api/' + fileRoute(purchaseId, file.id) + '/download'} download={file.originalName}
      aria-label={'Baixar ' + file.originalName}><Download size={14} aria-hidden="true" />Baixar</a>
    {edit && <button type="button" className="btn ghost small" disabled={busy} aria-label={'Excluir ' + file.originalName}
      onClick={() => setConfirming(true)}><Trash2 size={14} aria-hidden="true" />Excluir</button>}
  </div>;
}

/** Documents of one purchase, shown inside its details. Converted and reversed purchases accept them too. */
export function PurchaseAttachments({ purchaseId, edit }: { purchaseId: string; edit: boolean }) {
  const path = 'purchases/' + purchaseId + '/documents';
  const { data, error, loading, reload } = useData<PurchaseFile[]>(path);
  const [type, setType] = useState<DocumentType>('INVOICE');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    try {
      await work();
      await reload();
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function send(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxBytes) { setFailure('O arquivo passa do limite de 20 MB.'); return; }
    const body = new FormData();
    body.append('type', type);
    body.append('file', file);
    void run(async () => {
      await api(path, body);
      notify(file.name + ' anexado.');
    });
  }

  return <section className="preview-box" aria-busy={busy}>
    <div className="section-head">
      <h3>Documentos</h3>
      {edit && <div className="actions">
        <Select name="documentType" label="Tipo do documento" defaultValue={type} options={typeOptions} onChange={value => setType(value as DocumentType)} />
        <input ref={input} type="file" hidden accept={accepted} aria-label="Escolher documento da compra" onChange={send} />
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />{busy ? 'Aguarde…' : 'Anexar'}</button>
      </div>}
    </div>
    {edit && <p className="hint">PDF, imagem ou XML, até 20 MB por arquivo.</p>}
    {message(failure || error)}
    {!data ? loading && <Loading label="Carregando documentos…" /> : <Table responsive={false} empty="Nenhum documento anexado."
      columns={['Arquivo', 'Tipo', { label: 'Tamanho', end: true }, 'Enviado', { label: 'Ações', actions: true }]}
      rows={data.map(file => [
        file.originalName, typeLabels[file.type], by(file.sizeBytes, fileSize(file.sizeBytes)),
        by(Date.parse(file.createdAt), dateTime(file.createdAt) + ' · ' + file.author),
        <FileActions key={file.id} purchaseId={purchaseId} file={file} edit={edit} busy={busy} removed={() => run(async () => {
          await api(path + '/' + file.id, undefined, 'DELETE');
          notify(file.originalName + ' excluído.');
        })} />,
      ])} />}
  </section>;
}

/** Search across the documents of every purchase. Filters, sorting and paging all run on the server. */
export function PurchaseDocuments({ edit }: { edit: boolean }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const options = useData<Options>('purchase-documents/filters');
  const query = new URLSearchParams(Object.entries({ ...filters, sort: sortParam(sort), page: page > 1 ? String(page) : undefined })
    .filter((entry): entry is [string, string] => !!entry[1]));
  const { data, error, loading, reload } = useData<SearchPage>('purchase-documents' + (query.size ? '?' + query : ''));
  const active = Object.values(filters).filter(Boolean).length;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function remove(row: Found) {
    setBusy(true);
    setFailure('');
    try {
      await api(fileRoute(row.purchase.id, row.id), undefined, 'DELETE');
      notify(row.originalName + ' excluído.');
      // Removing the last row of a page would leave the person on an empty one.
      if (data?.documents.length === 1 && page > 1) setPage(page - 1);
      else await reload();
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Filters active={active} apply={values => { setFilters(values); setPage(1); }} clear={() => { setFilters({}); setPage(1); }}>
      <Select name="supplierId" label="Fornecedor" required={false} placeholder="Todos" options={options.data?.suppliers ?? []} />
      <Field name="from" label="De" type="date" required={false} />
      <Field name="to" label="Até" type="date" required={false} />
      <Field name="number" label="Número" required={false} placeholder="Documento ou compra" />
      <Select name="type" label="Tipo" required={false} placeholder="Todos" options={typeOptions} />
      <Select name="productId" label="Produto" required={false} placeholder="Todos" options={options.data?.products ?? []} />
    </Filters>
    {message(options.error)}{message(failure || error)}
    {!data ? loading && <Loading label="Carregando documentos…" /> : <Table empty="Nenhum documento encontrado."
      sort={sort} onSort={next => { setSort(next); setPage(1); }}
      columns={[
        { label: 'Arquivo', sortKey: 'name' }, { label: 'Tipo', sortKey: 'type' }, { label: 'Compra', end: true, sortKey: 'purchaseNumber' }, { label: 'Data', sortKey: 'purchaseDate' },
        { label: 'Fornecedor', sortKey: 'supplier' }, { label: 'Documento', sortKey: 'documentNumber' }, { label: 'Tamanho', end: true, sortKey: 'size' },
        { label: 'Enviado', sortKey: 'uploadedAt' }, { label: 'Ações', actions: true },
      ]}
      rows={data.documents.map(row => [
        <span className="cell-title">{row.originalName}</span>, typeLabels[row.type],
        <span className="num">{row.purchase.number}{row.purchase.reversedAt && <> <Badge tone="danger">Estornada</Badge></>}{row.purchase.converted && <> <Badge>Convertida</Badge></>}</span>,
        shortDate(row.purchase.purchaseDate), row.purchase.supplier?.name ?? '—', row.purchase.documentNumber ?? '—', fileSize(row.sizeBytes),
        dateTime(row.createdAt) + ' · ' + row.author,
        <FileActions key={row.id} purchaseId={row.purchase.id} file={row} edit={edit} busy={busy} removed={() => remove(row)} />,
      ])}
      footer={data.total > 0 && <>
        <span>Página {data.page} de {pages} · {data.total} {data.total === 1 ? 'documento' : 'documentos'}</span>
        {pages > 1 && <div className="actions">
          <button type="button" className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>}
      </>} />}
  </>;
}
