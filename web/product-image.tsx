import { ChangeEvent, useRef, useState } from 'react';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { api, message, notify } from './ui';

const maxBytes = 5 * 1024 * 1024;
const imagePath = (productId: string) => 'catalog/products/' + productId + '/image';
/** The file id in the address makes the browser ask again when the image is replaced. */
const imageUrl = (productId: string, fileId: string) => '/api/' + imagePath(productId) + '?v=' + fileId;

export function ProductThumb({ product }: { product: { id: string; name: string; imageFileId?: string | null } }) {
  const [failed, setFailed] = useState<string>();
  const fileId = product.imageFileId;
  return <span className="product-thumb">
    {fileId && failed !== fileId
      ? <img src={imageUrl(product.id, fileId)} alt={'Imagem de ' + product.name} loading="lazy" onError={() => setFailed(fileId)} />
      : <ImageIcon size={18} aria-hidden="true" />}
  </span>;
}

export function ProductImageField({ product, changed }: {
  product: { id: string; name: string; imageFileId?: string | null }; changed: () => Promise<void>;
}) {
  const [fileId, setFileId] = useState(product.imageFileId ?? null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    try {
      await work();
      await changed();
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function send(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxBytes) { setFailure('A imagem passa do limite de 5 MB.'); return; }
    const body = new FormData();
    body.append('file', file);
    void run(async () => {
      const saved = await api<{ id: string }>(imagePath(product.id), body);
      setFileId(saved.id);
      notify('Imagem salva.');
    });
  }

  return <section className="preview-box" aria-busy={busy}>
    <div className="section-head">
      <h3>Imagem</h3>
      <div className="actions">
        <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="Escolher imagem do produto" onChange={send} />
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />{busy ? 'Aguarde…' : fileId ? 'Trocar imagem' : 'Enviar imagem'}</button>
        {fileId && (confirming ? <>
          <button type="button" className="btn danger small" disabled={busy} onClick={() => void run(async () => {
            await api(imagePath(product.id), undefined, 'DELETE');
            setFileId(null);
            notify('Imagem excluída.');
          })}>Confirmar exclusão</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
        </> : <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" />Excluir</button>)}
      </div>
    </div>
    <p className="hint">JPG, PNG ou WebP, até 5 MB. Aparece na lista do catálogo.</p>
    {message(failure)}
    {fileId && <img className="product-image-preview" src={imageUrl(product.id, fileId)} alt={'Imagem de ' + product.name} />}
  </section>;
}
