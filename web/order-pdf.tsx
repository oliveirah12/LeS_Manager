import { useCallback } from 'react';
import { orderReport, ReportRevision } from './order-report';
import type { Order } from './orders';
import { PdfViewer } from './pdf-viewer';
import { api } from './ui';

export function OrderPdf({ order, statusName, seeCosts, close }: { order: Order; statusName: string; seeCosts: boolean; close: () => void }) {
  const build = useCallback(async () => {
    const revisions = order.revision > 0 ? await api<ReportRevision[]>('production/orders/' + order.id + '/revisions') : [];
    return orderReport(order, statusName, seeCosts, revisions);
  }, [order, statusName, seeCosts]);
  return <PdfViewer title={'PDF da ordem #' + order.number} subtitle={statusName} fileName={'ordem-producao-' + order.number + '.pdf'} build={build} close={close} />;
}
