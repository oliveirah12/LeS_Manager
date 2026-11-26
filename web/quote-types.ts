export type QuoteStatus = 'DRAFT' | 'SENT' | 'APPROVED' | 'REJECTED';
export type QuoteAction = 'edit' | 'send' | 'approve' | 'reject' | 'delete';
export type QuoteDetail = { label: string; value: string };
/** Margins, budget and result only come with stock:view. */
export type QuoteItem = {
  productId: string; sku: string; name: string; symbol: string; imageFileId: string | null; quantity: string; salePrice: string; total: string; marginPercent?: string | null;
};
export type QuoteBudget = {
  machineCost: string; expenseCost: string; materialCost: string; totalCost: string; partialCost: boolean; missingCost: string[];
  items: { productId: string; totalCost: string; unitCost: string; pricedCost: string | null; suggestedPrice: string | null; realMargin: string | null; belowTargetMargin: boolean }[];
};
export type Quote = {
  id: string; number: number; status: QuoteStatus; actions: QuoteAction[];
  customerName: string; customerContact: string | null; title: string; description: string | null; details: QuoteDetail[];
  printPlates: number | null; estimatedMinutes: number; deliveryDays: number | null; validUntil: string; expired: boolean; notes: string | null;
  printer: { id: string; name: string }; user: { name: string }; createdAt: string; sentAt: string | null; decidedAt: string | null;
  productionOrder: { id: string; number: number } | null;
  discountPercent: string; paymentMethodId: string | null; paymentName: string | null; feePercent: string; customFee: boolean;
  items: QuoteItem[]; expenses: { title: string; value: string }[];
  sale: { gross: string; discount: string; total: string; fee: string; net: string; profit?: string; marginPercent?: string | null } | null;
  budget: QuoteBudget | null;
};
export type QuotesView = {
  quotes: Quote[]; page: number; pageSize: number; total: number; quoteValidityDays: number;
  printers: { id: string; name: string }[]; paymentMethods: { id: string; name: string; feePercent: string | null }[];
  products: { id: string; sku: string; name: string; symbol: string; printMinutes: string | null; salePrice: string | null; marginPercent?: string | null }[];
};
