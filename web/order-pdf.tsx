import { useEffect, useState } from 'react';
import { Download, Share2 } from 'lucide-react';
import { orderReport, ReportRevision } from './order-report';
import type { Order } from './orders';
import { renderPdf } from './pdf';
import { api, Loading, message, Modal } from './ui';

/** Builds the order's PDF in the browser and shows it here. Without a built-in viewer, as on many phones, the buttons still deliver the file. */
export function OrderPdf({ order, statusName, seeCosts, close }: { order: Order; statusName: string; seeCosts: boolean; close: () => void }) {
  const [pdf, setPdf] = useState<{ url: string; file: File }>();
  const [error, setError] = useState('');
  const fileName = 'ordem-producao-' + order.number + '.pdf';
  const canShow = navigator.pdfViewerEnabled !== false;
  const canShare = Boolean(pdf && navigator.canShare?.({ files: [pdf.file] }));

  useEffect(() => {
    let active = true;
    let created = '';
    (async () => {
      const revisions = order.revision > 0 ? await api<ReportRevision[]>('production/orders/' + order.id + '/revisions') : [];
      const bytes = await renderPdf(orderReport(order, statusName, seeCosts, revisions));
      if (!active) return;
      const file = new File([bytes as BlobPart], fileName, { type: 'application/pdf' });
      created = URL.createObjectURL(file);
      setPdf({ url: created, file });
    })().catch(err => { if (active) setError((err as Error).message || 'Não foi possível gerar o PDF.'); });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [order, statusName, seeCosts, fileName]);

  /** The file is ready before the click, because browsers only open the share menu right after a tap. */
  async function share() {
    setError('');
    try {
      await navigator.share({ files: [pdf!.file], title: 'Ordem de produção #' + order.number });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Não foi possível compartilhar. Baixe o PDF e envie o arquivo.');
    }
  }

  return <Modal wide title={'PDF da ordem #' + order.number} subtitle={statusName} close={close}>
    <div className="pdf-viewer">
      {message(error)}
      {!pdf && !error && <Loading label="Gerando PDF…" />}
      {pdf && <>
        <div className="pdf-actions">
          <a className="btn secondary" href={pdf.url} download={fileName}><Download size={16} aria-hidden="true" />Baixar</a>
          <button type="button" className="btn" disabled={!canShare} title={canShare ? undefined : 'Este navegador não abre o menu de compartilhamento.'} onClick={() => void share()}>
            <Share2 size={16} aria-hidden="true" />Compartilhar</button>
        </div>
        {!canShare && <p className="hint">Este navegador não abre o menu de compartilhamento. Baixe o PDF para enviar.</p>}
        {canShow ? <iframe className="pdf-frame" src={pdf.url} title={'PDF da ordem ' + order.number} />
          : <p className="hint">Este navegador não mostra PDF dentro da página. Use os botões acima para abrir o arquivo.</p>}
      </>}
    </div>
  </Modal>;
}
