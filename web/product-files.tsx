import { ChangeEvent, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { fileSize } from './format';
import { api, by, dateTime, Loading, message, notify, Table, useData } from './ui';

type StoredFile = { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string; author: string };
export const maxFileBytes = 100 * 1024 * 1024;
/** Files chosen in the product form. They go up with the product save, so they also work before the product exists. */
export type PendingFiles = { files: File[]; change: (files: File[]) => void; changed: () => Promise<void> };

/** Attachments of a product. Without `edit`, the person only lists and downloads. Removing a saved file is immediate. */
export function ProductFiles({ productId, edit }: { productId?: string; edit?: PendingFiles }) {
  const path = productId ? 'catalog/products/' + productId + '/files' : null;
  const { data, error, loading, reload } = useData<StoredFile[]>(path);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirming, setConfirming] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !edit) return;
    if (file.size > maxFileBytes) { setFailure('O arquivo passa do limite de 100 MB.'); return; }
    setFailure('');
    edit.change([...edit.files, file]);
  }

  async function remove(file: StoredFile) {
    setBusy(true);
    setFailure('');
    try {
      await api(path + '/' + file.id, undefined, 'DELETE');
      notify(file.originalName + ' excluído.');
      await Promise.all([reload(), edit?.changed()]);
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  }

  const actions = (file: StoredFile) => <div className="actions">
    {confirming === file.id ? <>
      <button type="button" className="btn danger small" disabled={busy} onClick={() => void remove(file)}>Confirmar exclusão</button>
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(undefined)}>Cancelar</button>
    </> : <>
      <a className="btn secondary small" href={'/api/' + path + '/' + file.id + '/download'} download={file.originalName}
        aria-label={'Baixar ' + file.originalName}><Download size={14} aria-hidden="true" />Baixar</a>
      {edit && <button type="button" className="btn ghost small" disabled={busy} aria-label={'Excluir ' + file.originalName}
        onClick={() => setConfirming(file.id)}><Trash2 size={14} aria-hidden="true" />Excluir</button>}
    </>}
  </div>;
  const pendingRows = (edit?.files ?? []).map((file, index) => [
    <span>{file.name} <span className="hint">· enviado ao salvar</span></span>, by(file.size, fileSize(file.size)), 'Pendente',
    <div className="actions"><button type="button" className="btn ghost small" aria-label={'Remover ' + file.name}
      onClick={() => edit?.change(edit.files.filter((_, item) => item !== index))}><Trash2 size={14} aria-hidden="true" />Remover</button></div>,
  ]);

  return <section className="preview-box" aria-busy={busy}>
    <div className="section-head">
      <h3>Arquivos</h3>
      {edit && <>
        <input ref={input} type="file" hidden aria-label="Escolher arquivo do produto" onChange={pick} />
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />Adicionar arquivo</button>
      </>}
    </div>
    {edit && <p className="hint">Até 100 MB por arquivo. Programas e scripts não são aceitos. Os novos arquivos são enviados ao salvar o produto.</p>}
    {message(failure || error)}
    {path && !data ? loading && <Loading label="Carregando arquivos…" /> : <Table responsive={false} empty="Nenhum arquivo anexado."
      columns={['Arquivo', { label: 'Tamanho', end: true }, 'Enviado', { label: 'Ações', actions: true }]}
      rows={[...pendingRows, ...(data ?? []).map(file => [
        file.originalName, by(file.sizeBytes, fileSize(file.sizeBytes)),
        by(Date.parse(file.createdAt), dateTime(file.createdAt) + ' · ' + file.author), actions(file),
      ])]} />}
  </section>;
}
