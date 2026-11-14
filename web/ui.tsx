import { FormEvent, ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/' + path, {
      method,
      ...(body instanceof FormData ? { body } : body === undefined ? {} : {
        body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
      }),
    });
  } catch {
    throw new Error(navigator.onLine ? 'Servidor indisponível. Tente novamente em instantes.' : 'Sem conexão com a internet. Confira a rede e tente novamente.');
  }
  // A proxy or a restarting server may answer with an HTML page instead of the API's JSON.
  const data = await response.json().catch(() => undefined);
  if (data === undefined) {
    throw new Error(response.status >= 500 || response.ok ? 'Servidor indisponível. Tente novamente em instantes.' : 'Falha na operação (' + response.status + ').');
  }
  if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(' · ') : data.message ?? 'Falha na operação.');
  return data;
}

export function useData<T>(path: string) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>();
  const request = useRef(0);
  const activePath = useRef(path);
  const mounted = useRef(false);
  activePath.current = path;
  const [loading, setLoading] = useState(true);
  async function reload() {
    if (!mounted.current || path !== activePath.current) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const data = await api<T>(path);
      if (id === request.current) setResult({ path, data });
    } catch (err) {
      if (id === request.current) setResult(previous => ({
        path, data: previous?.path === path ? previous.data : undefined, error: (err as Error).message,
      }));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; request.current++; };
  }, [path]);
  return { data: result?.path === path ? result.data : undefined, error: result?.path === path ? result.error ?? '' : '',
    loading: loading || result?.path !== path, reload };
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</p>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')?.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  function requestClose() {
    if (!dialog.current?.querySelector('[aria-busy="true"]')) close();
  }
  return createPortal(<dialog ref={dialog} className="modal" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); requestClose(); }}>
    <div className="modal-heading"><h2 id={heading}>{title}</h2>
      <button type="button" className="secondary icon-close" onClick={requestClose} aria-label="Fechar janela">×</button>
    </div>
    <div className="modal-content">{children}</div>
  </dialog>, document.body);
}

export function ModalForm({ title, close, ...form }: { title: string; close: () => void } & Parameters<typeof Form>[0]) {
  return <Modal title={title} close={close}>
    <Form {...form} action={async data => { await form.action(data); close(); }} />
  </Modal>;
}

export function FileField({ name, label, accept }: { name: string; label: string; accept: string }) {
  return <label className="file-field">{label}
    <input type="file" name={name} accept={accept} required />
  </label>;
}

export function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="section"><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}{children}</section>;
}

export function Form({ children, action, label, className, reset = false, disabled = false }: {
  children?: ReactNode; action: (data: FormData) => Promise<unknown>; label: string; className?: string; reset?: boolean; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError('');
    setBusy(true);
    try { await action(data); if (reset) form.reset(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className={className} aria-busy={busy}>
    <fieldset disabled={busy || disabled}>{children}<button type="submit">{busy && <span className="spinner" aria-hidden="true" />}{busy ? 'Aguarde…' : label}</button></fieldset>
    {error && <p role="alert" className="alert">{error}</p>}
  </form>;
}

export function Field({ name, label, type = 'text', defaultValue, required = true, placeholder }: {
  name: string; label: string; type?: string; defaultValue?: string; required?: boolean; placeholder?: string;
}) {
  return <label>{label}<input name={name} type={type} defaultValue={defaultValue} required={required} placeholder={placeholder} /></label>;
}

export function Select({ name, label, options, defaultValue, onChange, required = true }: {
  name: string; label: string; options: { id: string; name: string }[]; defaultValue?: string;
  onChange?: (id: string) => void; required?: boolean;
}) {
  return <label>{label}<select name={name} defaultValue={defaultValue ?? ''} required={required} onChange={event => onChange?.(event.target.value)}>
    <option value="">{required ? 'Selecione' : 'Nenhum'}</option>
    {options.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}
  </select></label>;
}

export function Table({ columns, rows, empty = 'Nenhum registro.' }: { columns: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="empty">{empty}</p>;
  return <div className="table-wrap"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}

export const fields = (data: FormData) => Object.fromEntries([...data].map(([key, value]) => [key, String(value)]));
export const decimal = (value: string) => value.replace('.', ',');
export const brl = (value: string | null) => value == null ? '—' : 'R$ ' + decimal(value);
export const dateTime = (value: string) => new Date(value).toLocaleString('pt-BR');
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
export const accessible = (permissions: string[], permission: string) => permissions.includes('admin') || permissions.includes(permission) ||
  (permission.endsWith(':view') && permissions.includes(permission.replace(':view', ':operate')));
export const message = (text: string) => text && <p role="alert" className="alert">{text}</p>;

export type Identity = { id: string; name: string; email: string; profileName: string; permissions: string[] };
export type Unit = { id: string; symbol: string; factor: string; familyId: string; isBase: boolean };
export type Product = {
  id: string; sku: string; name: string; unit: Unit & { family: { units: Unit[] } }; quantity: string; currentCost: string | null; lastPurchaseCost: string | null;
  groupId: string | null; brandId: string | null; colorId: string | null; departmentId: string | null;
};
export type Kit = {
  id: string; sku: string; name: string; available: string;
  components: { productId: string; quantity: string; product: Product }[];
};
export type StockView = { products: Product[]; kits: Kit[]; units: Unit[] };
export const baseUnit = (product: Pick<Product, 'unit'>) => product.unit.family.units[0] ?? product.unit;
export const productOptions = (products: Product[]) => products.map(product => ({ id: product.id, name: product.sku + ' · ' + product.name }));
export const unitOptions = (units: Unit[], bySymbol = false) => units.map(unit => ({ id: bySymbol ? unit.symbol : unit.id, name: unit.symbol }));
