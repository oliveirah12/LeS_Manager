export type QuoteStatus = 'DRAFT' | 'SENT' | 'APPROVED' | 'REJECTED';
export const quoteStatusNames: Record<QuoteStatus, string> = { DRAFT: 'Rascunho', SENT: 'Enviado', APPROVED: 'Aprovado', REJECTED: 'Recusado' };

/** Where each action is allowed. An approved quote is locked, and only a rejected one may be deleted. */
const allowed = {
  edit: ['DRAFT', 'SENT'], send: ['DRAFT'], approve: ['DRAFT', 'SENT'], reject: ['DRAFT', 'SENT'], delete: ['REJECTED'],
} as const satisfies Record<string, readonly QuoteStatus[]>;
export type QuoteAction = keyof typeof allowed;

const refusals: Record<QuoteAction, string> = {
  edit: 'Só um orçamento em rascunho ou enviado pode ser editado.',
  send: 'Só um orçamento em rascunho pode ser enviado.',
  approve: 'Só um orçamento em rascunho ou enviado pode ser aprovado.',
  reject: 'Só um orçamento em rascunho ou enviado pode ser recusado.',
  delete: 'Só um orçamento recusado pode ser excluído.',
};

/** Why the action is refused in this situation, or null when it is allowed. */
export function quoteBlock(status: QuoteStatus, action: QuoteAction) {
  return (allowed[action] as readonly QuoteStatus[]).includes(status) ? null : refusals[action];
}

/** The actions the panel may offer, so the buttons follow the same rule as the API. */
export const quoteActions = (status: QuoteStatus) => (Object.keys(allowed) as QuoteAction[]).filter(action => !quoteBlock(status, action));

/** Calendar day `days` after `day`, both as YYYY-MM-DD, without time zones moving the date. */
export function addDays(day: string, days: number) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
