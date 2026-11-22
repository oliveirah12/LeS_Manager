import { createContext, FormEvent, KeyboardEvent, ReactNode, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronsUpDown, Eye, EyeOff, Inbox, Search, SlidersHorizontal, X } from 'lucide-react';
import { nextSort, sortRows, SortState, SortValue } from './format';

/* ---------- Data ---------- */

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
  // An expired session anywhere sends the person back to the sign-in screen once, instead of an error per block.
  if (response.status === 401 && !path.startsWith('access/')) dispatchEvent(new Event(sessionExpired));
  if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(' · ') : data.message ?? 'Falha na operação.');
  return data;
}
export const sessionExpired = 'les-manager:session-expired';

export function useData<T>(path: string | null) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>();
  const request = useRef(0);
  const activePath = useRef(path);
  const mounted = useRef(false);
  activePath.current = path;
  const [loading, setLoading] = useState(path !== null);
  async function reload() {
    if (!mounted.current || path === null || path !== activePath.current) return;
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
    loading: path !== null && (loading || result?.path !== path), reload };
}

/* ---------- Formatting ---------- */

// The screens keep importing these from ui; the pure logic lives in format so the tests can load it.
export { accessible, applyFilters, brl, decimal, displayDate, quantity, yesNo, yesNoOptions } from './format';
export { sortParam } from './format';
export type { SortState, TableFilter } from './format';
export const dateTime = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
export function relativeTime(value: string) {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return 'há ' + minutes + ' min';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return 'há ' + hours + ' h';
  return dateTime(value);
}


/* ---------- Feedback ---------- */

export const message = (text: string) => text ? <p role="alert" className="alert">{text}</p> : null;

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</p>;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return <div className="empty">{icon ?? <Inbox size={28} aria-hidden="true" />}<span>{children}</span></div>;
}

type Toast = { id: number; text: string; leaving?: boolean };
const toastListeners = new Set<(toast: Toast) => void>();
let toastId = 0;
/** Shows a short confirmation that disappears on its own. */
export function notify(text: string) {
  const toast = { id: ++toastId, text };
  toastListeners.forEach(listener => listener(toast));
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (toast: Toast) => {
      setToasts(items => [...items.slice(-2), toast]);
      setTimeout(() => setToasts(items => items.map(item => item.id === toast.id ? { ...item, leaving: true } : item)), 3200);
      setTimeout(() => setToasts(items => items.filter(item => item.id !== toast.id)), 3400);
    };
    toastListeners.add(add);
    return () => { toastListeners.delete(add); };
  }, []);
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map(toast => <div key={toast.id} className={'toast' + (toast.leaving ? ' leaving' : '')}>
      <CheckCircle2 size={18} aria-hidden="true" />{toast.text}
    </div>)}
  </div>;
}

/* ---------- Page layout ---------- */

const PageActionsSlot = createContext<HTMLElement | null>(null);
export const PageActionsProvider = PageActionsSlot.Provider;

/** Renders buttons into the current page header, beside the title. */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

export function Section({ title, subtitle, actions, children }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="section">
    {(title || actions) && <div className="section-head">
      <div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>}
    {children}
  </section>;
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'brand' | 'danger'; children: ReactNode }) {
  return <span className={'badge' + (tone ? ' tone-' + tone : '')}>{children}</span>;
}

/* ---------- Dialogs ---------- */

/** A side panel on desktop and a bottom sheet on phones. Plays an exit animation before closing. */
export function Modal({ title, subtitle, close, wide = false, children }: {
  title: string; subtitle?: string; close: () => void; wide?: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select, textarea')?.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  // The person cannot dismiss a panel while it saves; the code closes it after a successful save.
  function requestClose(force = false) {
    if (closing || (!force && dialog.current?.querySelector('[aria-busy="true"]'))) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { close(); return; }
    setClosing(true);
  }
  return createPortal(<dialog ref={dialog} className={'panel' + (wide ? ' wide' : '') + (closing ? ' closing' : '')} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onClick={event => { if (event.target === dialog.current) requestClose(); }}
    onAnimationEnd={event => { if (closing && event.target === dialog.current) close(); }}>
    <div className="panel-grip" aria-hidden="true" />
    <div className="panel-head">
      <div><h2 id={heading}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <button type="button" className="icon-button" onClick={() => requestClose()} aria-label="Fechar"><X size={20} aria-hidden="true" /></button>
    </div>
    <div className="panel-body"><CloseContext.Provider value={() => requestClose(true)}>{children}</CloseContext.Provider></div>
  </dialog>, document.body);
}

const CloseContext = createContext<(() => void) | null>(null);
/** Closes the enclosing panel with its exit animation. */
export const useClosePanel = () => useContext(CloseContext);

export function ModalForm({ title, subtitle, close, wide, ...form }: {
  title: string; subtitle?: string; close: () => void; wide?: boolean;
} & Parameters<typeof Form>[0]) {
  return <Modal title={title} subtitle={subtitle} close={close} wide={wide}>
    <PanelForm {...form} />
  </Modal>;
}

function PanelForm(form: Parameters<typeof Form>[0]) {
  const closePanel = useClosePanel();
  return <Form {...form} cancel={form.cancel ?? 'Cancelar'} action={async data => { await form.action(data); closePanel?.(); }} />;
}

/* ---------- Forms ---------- */

export function Form({ children, action, label, reset = false, disabled = false, cancel, extra, danger = false }: {
  children?: ReactNode; action: (data: FormData) => Promise<unknown>; label: string; reset?: boolean; disabled?: boolean;
  cancel?: string; extra?: ReactNode; danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closePanel = useClosePanel();
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
  return <form onSubmit={submit} className="form" aria-busy={busy}>
    <fieldset disabled={busy || disabled}>{children}</fieldset>
    {error && <p role="alert" className="alert">{error}</p>}
    <div className="form-actions">
      {extra}
      {cancel && closePanel && <button type="button" className="btn secondary" disabled={busy} onClick={closePanel}>{cancel}</button>}
      <button type="submit" className={'btn' + (danger ? ' danger' : '')} disabled={busy || disabled}>
        {busy && <span className="spinner" aria-hidden="true" />}{busy ? 'Aguarde…' : label}
      </button>
    </div>
  </form>;
}

export function FileField({ name, label, accept, required = true, hint }: {
  name: string; label: string; accept: string; required?: boolean; hint?: string;
}) {
  return <label className="file-field">{label}
    <input type="file" name={name} accept={accept} required={required} />
    {hint && <span className="hint">{hint}</span>}
  </label>;
}

export function Field({ name, label, type = 'text', defaultValue, required = true, placeholder, hint, inputMode, autoComplete }: {
  name: string; label: string; type?: string; defaultValue?: string; required?: boolean; placeholder?: string; hint?: string;
  inputMode?: 'decimal' | 'numeric' | 'text' | 'email'; autoComplete?: string;
}) {
  return <label>{label}<input name={name} type={type} defaultValue={defaultValue} required={required} placeholder={placeholder}
    inputMode={inputMode} autoComplete={autoComplete} />
    {hint && <span className="hint">{hint}</span>}</label>;
}

/** Password input with a reveal button. The button stays outside the label so it does not become part of the field's name. */
export function PasswordField({ name, label, autoComplete, minLength, maxLength, hint }: {
  name: string; label: string; autoComplete: 'current-password' | 'new-password'; minLength?: number; maxLength?: number; hint?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return <div className="password-field">
    <label htmlFor={id}>{label}</label>
    <div className="password-input">
      <input id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      <button type="button" className="icon-button password-toggle" aria-label={(visible ? 'Ocultar ' : 'Mostrar ') + label.toLowerCase()}
        aria-pressed={visible} onClick={() => setVisible(value => !value)}><Icon size={16} aria-hidden="true" /></button>
    </div>
    {hint && <span className="hint">{hint}</span>}
  </div>;
}

export function Select({ name, label, options, defaultValue, onChange, required = true, placeholder }: {
  name: string; label: string; options: { id: string; name: string }[]; defaultValue?: string;
  onChange?: (id: string) => void; required?: boolean; placeholder?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const initial = useRef(defaultValue ?? '');
  const [value, setValue] = useState(initial.current);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const emptyLabel = placeholder ?? (required ? 'Selecione' : 'Nenhum');
  // Like a native select, a value without a matching option counts as empty.
  const selected = options.find(option => option.id === value);
  const current = selected?.id ?? '';
  const visible = query?.trim() ? options.filter(option => matches(query, option.name)) : [{ id: '', name: emptyLabel }, ...options];
  const optionId = (index: number) => id + '-option-' + index;

  // The hidden input carries the value, so the visible one reports the missing choice to the browser's validation.
  useLayoutEffect(() => { input.current?.setCustomValidity(required && !current ? 'Selecione uma opção.' : ''); }, [required, current]);
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const reset = () => { setValue(initial.current); setQuery(null); setOpen(false); };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, []);
  // A popover stays inside the dialog in the DOM but paints in the top layer, free of the panel's scroll clipping.
  useLayoutEffect(() => {
    if (!open) return;
    const popup = list.current!;
    popup.showPopover?.();
    const place = () => {
      const box = input.current!.getBoundingClientRect();
      const below = (window.visualViewport?.height ?? innerHeight) - box.bottom - 12;
      const above = box.top - 12;
      const upward = below < 180 && above > below;
      popup.style.maxHeight = Math.min(280, upward ? above : below) + 'px';
      popup.style.left = box.left + 'px';
      popup.style.width = box.width + 'px';
      popup.style.top = (upward ? box.top - 4 - popup.offsetHeight : box.bottom + 4) + 'px';
    };
    place();
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    // The panel slides in, so a list opened during the animation is placed again when it ends.
    addEventListener('animationend', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      removeEventListener('animationend', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open, visible.length]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function show() {
    setActive(Math.max(0, visible.findIndex(option => option.id === current)));
    setOpen(true);
  }
  function close() { setOpen(false); setQuery(null); }
  function choose(option: { id: string }) {
    setValue(option.id);
    close();
    if (option.id !== current) onChange?.(option.id);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else if (visible.length) setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (open && event.key === 'Enter') {
      event.preventDefault();
      if (visible[active]) choose(visible[active]);
    } else if (open && event.key === 'Escape') {
      // Closes only the list: the surrounding dialog stays open.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
  return <div className="combo">
    <label htmlFor={id}>{label}</label>
    <input type="hidden" name={name} value={current} />
    <input ref={input} id={id} role="combobox" autoComplete="off" spellCheck={false} placeholder={emptyLabel}
      aria-autocomplete="list" aria-expanded={open} aria-controls={id + '-list'} aria-required={required}
      aria-activedescendant={open && visible[active] ? optionId(active) : undefined}
      value={query ?? selected?.name ?? ''} onKeyDown={keyDown} onBlur={close}
      onFocus={event => event.currentTarget.select()}
      onClick={event => { if (!open) { show(); event.currentTarget.select(); } }}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} />
    <ChevronDown size={16} aria-hidden="true" className="combo-icon" />
    {open && <ul ref={list} id={id + '-list'} role="listbox" aria-label={label} className="combo-list" popover="manual"
      onMouseDown={event => event.preventDefault()}>
      {visible.map((option, index) => <li key={option.id || 'empty'} id={optionId(index)} role="option" aria-selected={option.id === current}
        data-active={index === active} className={option.id ? undefined : 'muted'} onMouseMove={() => setActive(index)} onClick={() => choose(option)}>{option.name}</li>)}
      {!visible.length && <li role="presentation" className="combo-none">Nada encontrado</li>}
    </ul>}
  </div>;
}

export function SearchInput({ value, onChange, label = 'Buscar', placeholder = 'Buscar por SKU ou nome' }: {
  value: string; onChange: (value: string) => void; label?: string; placeholder?: string;
}) {
  return <label className="search"><span className="sr-only">{label}</span>
    <Search size={16} aria-hidden="true" />
    <input type="search" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
  </label>;
}

export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string; options: { id: T; name: string }[]; value: T; onChange: (value: T) => void;
}) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map(option => <button type="button" key={option.id} aria-pressed={option.id === value} onClick={() => onChange(option.id)}>{option.name}</button>)}
  </div>;
}

export function Tabs<T extends string>({ label, tabs, value, onChange }: {
  label: string; tabs: { id: T; name: string }[]; value: T; onChange: (value: T) => void;
}) {
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button type="button" role="tab" key={tab.id} aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>{tab.name}</button>)}
  </div>;
}

/** A filter form. Always visible on wide screens; behind a "Filtros" button on phones. */
export function Filters({ children, active, apply, clear }: {
  children: ReactNode; active: number; apply: (values: Record<string, string>) => void; clear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="filters">
    <button type="button" className="btn secondary filters-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <SlidersHorizontal size={16} aria-hidden="true" />Filtros{active > 0 && <span className="badge tone-brand">{active}</span>}
    </button>
    <div id={id} className="filters-panel" data-open={open}><div>
      <form className="filters-form" onSubmit={event => { event.preventDefault(); apply(fields(new FormData(event.currentTarget))); setOpen(false); }}
        onReset={() => { clear(); setOpen(false); }}>
        {children}
        <div className="actions"><button type="submit" className="btn">Filtrar</button><button type="reset" className="btn secondary">Limpar</button></div>
      </form>
    </div></div>
  </div>;
}

/** Filter form built from definitions. A filter with nothing to choose stays hidden. */
export function TableFilters<T>({ filters, selected, onChange }: {
  filters: import('./format').TableFilter<T>[]; selected: Record<string, string>; onChange: (selected: Record<string, string>) => void;
}) {
  const shown = filters.filter(filter => filter.options.length > 0);
  return <Filters active={shown.filter(filter => selected[filter.id]).length} apply={onChange} clear={() => onChange({})}>
    {shown.map(filter => <Select key={filter.id} name={filter.id} label={filter.label} required={false} placeholder="Todos"
      defaultValue={selected[filter.id]} options={filter.options} />)}
  </Filters>;
}

/** Case- and accent-insensitive search over the given texts. */
export function matches(query: string, ...texts: (string | null | undefined)[]) {
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const needle = normalize(query.trim());
  return !needle || texts.some(text => text && normalize(text).includes(needle));
}

/* ---------- Tables ---------- */

export type Column = string | { label: string; end?: boolean; hideLabel?: boolean; actions?: boolean; sortKey?: string };

/** A drawn cell paired with the raw value it sorts by, such as an exact decimal behind "R$ 1.200,00". */
export class SortCell { constructor(readonly value: SortValue, readonly content: ReactNode) {} }
export const by = (value: SortValue, content: ReactNode = value) => new SortCell(value, content);
const rawValue = (cell: unknown): SortValue => cell instanceof SortCell ? cell.value : typeof cell === 'string' || typeof cell === 'number' ? cell : null;

/**
 * A table on wide screens and a list of cards on phones. The first column is each card's title.
 * Without onSort it sorts the rows it holds: a column qualifies when its cells carry a raw value, and numeric
 * (end) columns must use by(), since their text is formatted. With onSort the server sorts the columns with a sortKey.
 */
export function Table({ columns, rows, empty = 'Nenhum registro.', footer, responsive = true, sort, onSort }: {
  columns: Column[]; rows: (ReactNode | SortCell)[][]; empty?: string; footer?: ReactNode; responsive?: boolean;
  sort?: SortState; onSort?: (sort: SortState) => void;
}) {
  const [localSort, setLocalSort] = useState<SortState>(null);
  const specs = columns.map(column => typeof column === 'string' ? { label: column } as Exclude<Column, string> : column);
  const active = onSort ? sort ?? null : localSort;
  const sortKey = (column: Exclude<Column, string>, col: number) => {
    if (onSort) return column.sortKey;
    const sortable = !column.actions && rows.every(row => row[col] instanceof SortCell || (!column.end && rawValue(row[col]) !== null));
    return sortable ? column.label : undefined;
  };
  if (!rows.length) return <div className="table-card"><Empty>{empty}</Empty></div>;
  const sortedCol = !onSort && active ? specs.findIndex((column, col) => sortKey(column, col) === active.key) : -1;
  const indexed = rows.map((row, index) => ({ row, index }));
  // Each row keeps its original index as key, so React moves the row instead of rewriting it.
  const ordered = sortedCol < 0 ? indexed : sortRows(indexed, item => rawValue(item.row[sortedCol]), active!.direction, specs[sortedCol].end);
  return <div className={'table-card' + (responsive ? ' responsive' : '')}>
    <div className="table-scroll"><table>
      <thead><tr>{specs.map((column, col) => {
        const key = sortKey(column, col);
        const direction = key && active?.key === key ? active.direction : undefined;
        const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown;
        return <th key={column.label} className={column.end ? 'end' : undefined} scope="col"
          aria-sort={key ? (direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none') : undefined}>
          {key ? <button type="button" className="sort-button" onClick={() => (onSort ?? setLocalSort)(nextSort(active, key))}>
            {column.label}<Icon size={13} aria-hidden="true" /></button>
            : column.actions ? <span className="sr-only">{column.label}</span> : column.label}</th>;
      })}</tr></thead>
      <tbody>{ordered.map(({ row, index }) => <tr key={index}>{row.map((cell, col) => {
        const column = specs[col];
        const className = [column?.end && 'end', (column?.hideLabel || column?.actions) && 'no-label', column?.actions && 'actions-cell'].filter(Boolean).join(' ');
        return <td key={col} data-label={column?.label} className={className || undefined}>{cell instanceof SortCell ? cell.content : cell}</td>;
      })}</tr>)}</tbody>
    </table></div>
    {footer && <div className="table-footer">{footer}</div>}
  </div>;
}

/** Title and code stacked in the first cell of a row. */
export const Title = ({ name, code, mono = true }: { name: string; code?: string | null; mono?: boolean }) =>
  <><span className="cell-title">{name}</span>{code && <span className={"cell-sub" + (mono ? " mono" : "")}>{code}</span>}</>;

/* ---------- Domain types ---------- */

export const fields = (data: FormData) => Object.fromEntries([...data].map(([key, value]) => [key, String(value)]));

export type Identity = { id: string; name: string; email: string; profileName: string; permissions: string[] };
export type Unit = { id: string; symbol: string; factor: string; familyId: string; isBase: boolean };
export type Product = {
  id: string; sku: string; name: string; active: boolean; imageFileId?: string | null; unit: Unit & { family: { units: Unit[] } }; quantity: string; currentCost: string | null; lastPurchaseCost: string | null;
  lastPurchaseAt?: string | null; lastPurchaseExpense?: string | null; lastSupplier?: { name: string } | null;
  typeId: string; groupId: string | null; brandId: string | null; colorId: string | null; departmentId: string | null; deleteBlock?: string | null; reserved?: string; type?: { isManufactured: boolean }; hasRecipe?: boolean;
  lengthMm?: string | null; widthMm?: string | null; heightMm?: string | null; diameterMm?: string | null; purchaseUrl?: string | null;
  measures?: { name: string; value: string; unit: string }[]; fileCount?: number;
};
export type Kit = {
  id: string; sku: string; name: string; active: boolean; available: string; deleteBlock?: string | null;
  components: { productId: string; quantity: string; product: Product }[];
};
/** Product in the stock view, with its value at average cost computed by the API with exact decimals. */
export type StockProduct = Product & { value: string; available: string; minStock: string | null; belowMinimum: boolean; salePrice: string | null; margin: { profit: string; percent: string } | null;
  marginPercent: string | null; suggestedPrice: string | null; belowTargetMargin: boolean };
/** Costs computed by the API from the components' current average. */
export type StockKit = Omit<Kit, 'components'> & {
  components: (Kit['components'][number] & { cost: string | null; share: string | null; yields: string })[];
  totalCost: string; partialCost: boolean;
};
export type StockView = { products: StockProduct[]; kits: StockKit[]; units: Unit[]; totalValue: string };
export const baseUnit = (product: Pick<Product, 'unit'>) => product.unit.family.units[0] ?? product.unit;
export const productOptions = (products: Product[]) => products.map(product => ({ id: product.id, name: product.sku + ' · ' + product.name }));
export const unitOptions = (units: Unit[], bySymbol = false) => units.map(unit => ({ id: bySymbol ? unit.symbol : unit.id, name: unit.symbol }));
