import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BusyPeriod, freeSlots, localDay, monthDays, slotFits } from './slots';
import { dateTime, useData } from './ui';

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
/** Days read past the grid, so a long print started on its last days still sees the orders ahead. The API allows 62 days in all. */
const marginDays = 20;

/** Picks a start among the times when the printer can hold the whole print. */
export function StartPicker({ printerId, minutes, value, onChange, ignoreOrderId, allowPast, keepValue }: {
  printerId: string; minutes: number; value: string; onChange: (value: string) => void;
  ignoreOrderId?: string; allowPast: boolean; keepValue: boolean;
}) {
  const [now] = useState(() => new Date());
  const [month, setMonth] = useState(() => {
    const anchor = value ? new Date(value) : now;
    return { year: anchor.getFullYear(), month: anchor.getMonth() };
  });
  const [day, setDay] = useState(value.slice(0, 10));
  const [notice, setNotice] = useState('');
  const days = useMemo(() => monthDays(month.year, month.month), [month]);
  const last = days[days.length - 1];
  const query = new URLSearchParams({
    printerId, from: days[0].toISOString(), to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1 + marginDays).toISOString(),
    ...(ignoreOrderId ? { ignoreOrderId } : {}),
  });
  const { data, error, loading, reload } = useData<{ busy: BusyPeriod[] }>(printerId ? 'production/orders/schedule?' + query : null);
  const earliest = allowPast ? null : now;
  const ready = Boolean(printerId && minutes > 0 && data);
  const slots = useMemo(() => new Map(ready ? days.map(item => [localDay(item), freeSlots(item, minutes, data!.busy, earliest)]) : []), [ready, days, minutes, data, earliest]);
  const daySlots = slots.get(day) ?? [];
  const firstMonth = now.getFullYear() * 12 + now.getMonth();

  // Another month's agenda says nothing about the chosen time, so only the month that holds it can clear it.
  useEffect(() => {
    if (!data || !value || keepValue || minutes <= 0 || !days.some(item => localDay(item) === value.slice(0, 10))) return;
    if (slotFits(value, minutes, data.busy, earliest)) return;
    onChange('');
    setNotice('O horário escolhido não cabe mais nesta impressora. Escolha outro.');
  }, [data, value, keepValue, minutes, days, earliest]);

  const move = (step: number) => setMonth(current => {
    const next = new Date(current.year, current.month + step, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });
  const waiting = !printerId ? 'Escolha a impressora para ver a agenda.' : minutes <= 0 ? 'Informe o tempo de impressão para ver os horários livres.' : loading && !data ? 'Carregando agenda…' : '';

  return <div className="start-picker" role="group" aria-label="Início previsto">
    <div className="start-picker-head">
      <strong>Início previsto</strong>
      <div className="start-picker-month">
        <button type="button" className="icon-button" aria-label="Mês anterior" disabled={!allowPast && month.year * 12 + month.month <= firstMonth} onClick={() => move(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
        <span aria-live="polite">{new Date(month.year, month.month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="icon-button" aria-label="Próximo mês" onClick={() => move(1)}><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="start-picker-days">
      {weekdays.map(name => <span key={name} className="start-picker-weekday" aria-hidden="true">{name}</span>)}
      {days.map(item => {
        const key = localDay(item);
        const free = slots.get(key)?.length ?? 0;
        const classes = ['start-picker-day', item.getMonth() !== month.month && 'outside', key === localDay(now) && 'today', key === value.slice(0, 10) && 'chosen', key === day && 'open'];
        return <button type="button" key={key} className={classes.filter(Boolean).join(' ')} disabled={!free} aria-pressed={key === day}
          aria-label={item.toLocaleDateString('pt-BR', { dateStyle: 'long' }) + (free ? ', ' + free + ' horários livres' : ', sem horário livre')} onClick={() => setDay(key)}>{item.getDate()}</button>;
      })}
    </div>
    {error && <p role="alert" className="alert">{error} <button type="button" className="btn ghost small" onClick={() => void reload()}>Tentar de novo</button></p>}
    {waiting ? <p className="hint">{waiting}</p> : !error && (!day || !slots.has(day) ? <p className="hint">Escolha um dia.</p>
      : daySlots.length ? <div className="start-picker-times" role="group" aria-label="Horários livres">
        {daySlots.map(slot => <button type="button" key={slot} className={'start-picker-time' + (slot === value ? ' chosen' : '')} aria-pressed={slot === value}
          onClick={() => { setNotice(''); onChange(slot); }}>{slot.slice(11)}</button>)}
      </div> : <p className="hint">Nenhum horário livre neste dia.</p>)}
    {notice && <p role="alert" className="alert">{notice}</p>}
    {value && <p className="hint">Início escolhido: <strong>{dateTime(value)}</strong></p>}
  </div>;
}
