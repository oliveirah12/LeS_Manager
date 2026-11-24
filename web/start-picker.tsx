import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BusyPeriod, clashingPeriods, dayPeriods, localDay, monthDays } from './slots';
import { useData } from './ui';

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
/** Days read past the grid, so a long print started on its last days still sees the orders ahead. The API allows 62 days in all. */
const marginDays = 20;

/** Shows the date only when the period leaves the chosen day. */
function periodTime(value: string, day: string) {
  const date = new Date(value);
  const hour = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return localDay(date) === day ? hour : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hour;
}
const periodText = (period: BusyPeriod, day: string) => periodTime(period.start, day) + ' – ' + periodTime(period.end, day);

/** Picks a day, shows what holds the printer on it, and takes any start outside those periods. */
export function StartPicker({ printerId, minutes, value, onChange, onBlocked, ignoreOrderId, keepValue }: {
  printerId: string; minutes: number; value: string; onChange: (value: string) => void; onBlocked: (reason: string) => void;
  ignoreOrderId?: string; keepValue: boolean;
}) {
  const [today] = useState(() => localDay(new Date()));
  const [month, setMonth] = useState(() => {
    const anchor = value ? new Date(value) : new Date();
    return { year: anchor.getFullYear(), month: anchor.getMonth() };
  });
  const [day, setDay] = useState(value.slice(0, 10));
  const [hour, setHour] = useState(value.slice(11, 16));
  const days = useMemo(() => monthDays(month.year, month.month), [month]);
  const last = days[days.length - 1];
  const query = new URLSearchParams({
    printerId, from: days[0].toISOString(), to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1 + marginDays).toISOString(),
    ...(ignoreOrderId ? { ignoreOrderId } : {}),
  });
  const { data, error, loading, reload } = useData<{ busy: BusyPeriod[] }>(printerId ? 'production/orders/schedule?' + query : null);
  const busy = data?.busy;
  const openDay = days.find(item => localDay(item) === day);
  const periods = useMemo(() => busy && openDay ? dayPeriods(openDay, busy) : [], [busy, openDay]);
  // An order saved before the rule may overlap another, and keeping its time stays allowed.
  const clashes = useMemo(() => busy && openDay && value && !keepValue ? clashingPeriods(value, minutes, busy) : [], [busy, openDay, value, minutes, keepValue]);
  const warning = clashes.length ? 'Horário ocupado: conflita com ' + clashes.map(period => 'a ordem #' + period.number + ' (' + periodText(period, day) + ')').join(' e ') + '.' : '';

  // Another month's agenda says nothing about the chosen time, so the last answer stands until its month is back.
  useEffect(() => {
    if (keepValue) onBlocked('');
    else if (busy && openDay) onBlocked(warning);
  }, [busy, openDay, warning, keepValue]);

  const choose = (nextDay: string, nextHour: string) => {
    setDay(nextDay);
    setHour(nextHour);
    onChange(nextDay && nextHour ? nextDay + 'T' + nextHour : '');
  };
  const move = (step: number) => setMonth(current => {
    const next = new Date(current.year, current.month + step, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return <div className="start-picker" role="group" aria-label="Início previsto">
    <div className="start-picker-head">
      <strong>Início previsto</strong>
      <div className="start-picker-month">
        <button type="button" className="icon-button" aria-label="Mês anterior" onClick={() => move(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
        <span aria-live="polite">{new Date(month.year, month.month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="icon-button" aria-label="Próximo mês" onClick={() => move(1)}><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="start-picker-days">
      {weekdays.map(name => <span key={name} className="start-picker-weekday" aria-hidden="true">{name}</span>)}
      {days.map(item => {
        const key = localDay(item);
        const taken = busy ? dayPeriods(item, busy).length : 0;
        const classes = ['start-picker-day', item.getMonth() !== month.month && 'outside', key === today && 'today', key === day && 'chosen', taken > 0 && 'taken'];
        return <button type="button" key={key} className={classes.filter(Boolean).join(' ')} aria-pressed={key === day}
          aria-label={item.toLocaleDateString('pt-BR', { dateStyle: 'long' }) + (taken ? ', ' + taken + (taken === 1 ? ' ordem' : ' ordens') : '')}
          onClick={() => choose(key, hour)}>{item.getDate()}</button>;
      })}
    </div>
    {error && <p role="alert" className="alert">{error} <button type="button" className="btn ghost small" onClick={() => void reload()}>Tentar de novo</button></p>}
    {!printerId ? <p className="hint">Escolha a impressora para ver a agenda.</p>
      : !day ? <p className="hint">Escolha um dia para ver os horários ocupados.</p>
      : loading && !data ? <p className="hint">Carregando agenda…</p>
      : openDay && data && <div className="start-picker-agenda">
        <strong>Ocupado em {openDay.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}</strong>
        {periods.length ? <ul className="start-picker-busy">
          {periods.map(period => <li key={period.number} className={clashes.includes(period) ? 'blocking' : undefined}>
            <span>{periodText(period, day)}</span><span>Ordem #{period.number}</span>
          </li>)}
        </ul> : <p className="hint">Nenhum horário ocupado neste dia.</p>}
      </div>}
    <label>Horário de início
      <input name="startTime" type="time" required disabled={!day} aria-invalid={Boolean(warning)} value={hour} onChange={event => choose(day, event.target.value)} />
    </label>
    {warning && <p role="alert" className="alert">{warning}</p>}
  </div>;
}
