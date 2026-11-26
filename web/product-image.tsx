import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { ImageIcon, Trash2, Undo2, Upload } from 'lucide-react';
import { api, message, notify } from './ui';

export const maxImageBytes = 5 * 1024 * 1024;
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

/** Shows a chosen file before it is sent, and frees the memory when the choice changes. */
function usePreview(file: File | null) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) { setUrl(undefined); return; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/**
 * The image of the product form. A new image stays pending and goes up with the product save, so it also
 * works before the product exists. Removing a saved image is immediate and asks for confirmation.
 */
export function ProductImageField({ product, name, pending, choose, changed }: {
  product?: { id: string; imageFileId?: string | null }; name: string; pending: File | null; choose: (file: File | null) => void; changed: () => Promise<void>;
}) {
  const [fileId, setFileId] = useState(product?.imageFileId ?? null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const preview = usePreview(pending);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxImageBytes) { setFailure('A imagem passa do limite de 5 MB.'); return; }
    setFailure('');
    choose(file);
  }

  async function remove(productId: string) {
    setBusy(true);
    setFailure('');
    try {
      await api(imagePath(productId), undefined, 'DELETE');
      setFileId(null);
      notify('Imagem excluída.');
      await changed();
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return <section className="preview-box" aria-busy={busy}>
    <div className="section-head">
      <h3>Imagem</h3>
      <div className="actions">
        <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="Escolher imagem do produto" onChange={pick} />
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden="true" />{pending || fileId ? 'Trocar imagem' : 'Escolher imagem'}</button>
        {pending && <button type="button" className="btn ghost small" onClick={() => choose(null)}><Undo2 size={14} aria-hidden="true" />Desfazer</button>}
        {!pending && product && fileId && (confirming ? <>
          <button type="button" className="btn danger small" disabled={busy} onClick={() => void remove(product.id)}>Confirmar exclusão</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
        </> : <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" />Excluir</button>)}
      </div>
    </div>
    <p className="hint">JPG, PNG ou WebP, até 5 MB. Aparece na lista do catálogo.{pending && ' A nova imagem é enviada ao salvar o produto.'}</p>
    {message(failure)}
    {preview ? <img className="product-image-preview" src={preview} alt={'Nova imagem de ' + (name || 'produto')} />
      : product && fileId && <img className="product-image-preview" src={imageUrl(product.id, fileId)} alt={'Imagem de ' + name} />}
  </section>;
}
