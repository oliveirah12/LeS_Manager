import { ChangeEvent, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { fileSize } from './format';
import { api, by, dateTime, Loading, message, notify, Table, useData } from './ui';

type StoredFile = { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string; author: string };
const maxBytes = 100 * 1024 * 1024;

/** Attachments of a saved product. Without `edit`, the person only lists and downloads. */
export function ProductFiles({ productId, edit, changed }: { productId: string; edit: boolean; changed?: () => Promise<void> }) {
  const path = 'catalog/products/' + productId + '/files';
  const { data, error, loading, reload } = useData<StoredFile[]>(path);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirming, setConfirming] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    try {
      await work();
      await Promise.all([reload(), changed?.()]);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

  function send(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxBytes) { setFailure('O arquivo passa do limite de 100 MB.'); return; }
    const body = new FormData();
    body.append('file', file);
    void run(async () => {
      await api(path, body);
      notify(file.name + ' enviado.');
    });
  }

  const actions = (file: StoredFile) => <div className="actions">
    {confirming === file.id ? <>
      <button type="button" className="btn danger small" disabled={busy} onClick={() => void run(async () => {
        await api(path + '/' + file.id, undefined, 'DELETE');
        notify(file.originalName + ' excluído.');
      })}>Confirmar exclusão</button>
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(undefined)}>Cancelar</button>
    </> : <>
      <a className="btn secondary small" href={'/api/' + path + '/' + file.id + '/download'} download={file.originalName}
        aria-label={'Baixar ' + file.originalName}><Download size={14} aria-hidden="true" />Baixar</a>
      {edit && <button type="button" className="btn ghost small" disabled={busy} aria-label={'Excluir ' + file.originalName}
        onClick={() => setConfirming(file.id)}><Trash2 size={14} aria-hidden="true" />Excluir</button>}
    </>}
  </div>;

  return <section className="preview-box" aria-busy={busy}>
    <div className="section-head">
      <h3>Arquivos</h3>
      {edit && <>
        <input ref={input} type="file" hidden aria-label="Escolher arquivo do produto" onChange={send} />
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />{busy ? 'Aguarde…' : 'Enviar arquivo'}</button>
      </>}
    </div>
    {edit && <p className="hint">Até 100 MB por arquivo. Programas e scripts não são aceitos.</p>}
    {message(failure || error)}
    {!data ? loading && <Loading label="Carregando arquivos…" /> : <Table responsive={false} empty="Nenhum arquivo anexado."
      columns={['Arquivo', { label: 'Tamanho', end: true }, 'Enviado', { label: 'Ações', actions: true }]}
      rows={data.map(file => [
        file.originalName, by(file.sizeBytes, fileSize(file.sizeBytes)),
        by(Date.parse(file.createdAt), dateTime(file.createdAt) + ' · ' + file.author), actions(file),
      ])} />}
  </section>;
}
