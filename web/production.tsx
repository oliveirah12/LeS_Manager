import { useState } from 'react';
import { Pencil, Plus, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { api, Badge, brl, by, decimal, Field, fields, Loading, message, Modal, ModalForm, notify, PageActions, Section, Table, useData } from './ui';

type Printer = { id: string; name: string; powerWatts: string; hourlyCost: string; hourCost: string; active: boolean; deleteBlock: string | null };
type PrinterView = { energyRate: string; printers: Printer[] };

export function Printers({ edit }: { edit: boolean }) {
  const { data, error, loading, reload } = useData<PrinterView>('production/printers');
  const [printer, setPrinter] = useState<Printer | null>();
  const [status, setStatus] = useState<Printer>();
  const [removal, setRemoval] = useState<Printer>();
  const [editingRate, setEditingRate] = useState(false);
  async function done(text: string) {
    notify(text);
    await reload();
  }
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setPrinter(null)}><Plus size={16} aria-hidden="true" />Nova impressora</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando impressoras…" /> : <div className="stack">
      <Section title="Tarifa de energia" actions={edit && <button type="button" className="btn secondary small" onClick={() => setEditingRate(true)}>
        <Zap size={14} aria-hidden="true" />Alterar tarifa</button>}>
        <p><strong className="num">{brl(data.energyRate)}</strong> <span className="muted">por kWh</span></p>
        {Number(data.energyRate) === 0 && <p className="hint">Informe a tarifa da sua conta de luz para incluir a energia no custo das impressões.</p>}
      </Section>
      <Table empty="Nenhuma impressora cadastrada."
        columns={['Impressora', { label: 'Potência', end: true }, { label: 'Desgaste por hora', end: true }, { label: 'Custo por hora', end: true }, 'Situação',
          ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={data.printers.map(row => [
          by(row.name, <span className="cell-title">{row.name}</span>), by(row.powerWatts, decimal(row.powerWatts) + ' W'), by(row.hourlyCost, brl(row.hourlyCost)),
          by(row.hourCost, <strong>{brl(row.hourCost)}</strong>),
          by(row.active ? 'Ativa' : 'Inativa', row.active ? <Badge tone="ok"><span className="dot" />Ativa</Badge> : <Badge>Inativa</Badge>),
          ...(edit ? [<div className="actions">
            <button type="button" className="btn secondary small" onClick={() => setPrinter(row)}><Pencil size={14} aria-hidden="true" />Editar</button>
            <button type="button" className="btn ghost small" onClick={() => setStatus(row)}>
              {row.active ? <PowerOff size={14} aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}{row.active ? 'Inativar' : 'Reativar'}</button>
            <button type="button" className={'btn ghost small' + (row.deleteBlock ? ' unavailable' : '')} title={row.deleteBlock ?? undefined}
              onClick={() => setRemoval(row)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
          </div>] : []),
        ])} />
    </div>}

    {edit && printer !== undefined && <ModalForm title={printer ? 'Editar impressora' : 'Nova impressora'} close={() => setPrinter(undefined)} label="Salvar"
      action={async values => {
        await api('production/printers' + (printer ? '/' + printer.id : ''), fields(values), printer ? 'PATCH' : 'POST');
        await done(printer ? 'Alterações salvas.' : 'Impressora cadastrada.');
      }}>
      <Field name="name" label="Nome" placeholder="Ex.: Ender 3 V3" defaultValue={printer?.name} />
      <div className="form-grid">
        <Field name="powerWatts" label="Potência (W)" inputMode="decimal" placeholder="200" defaultValue={printer?.powerWatts}
          hint="Consumo médio durante a impressão." />
        <Field name="hourlyCost" label="Desgaste por hora (R$)" inputMode="decimal" placeholder="2,00" defaultValue={printer?.hourlyCost}
          hint="Manutenção e depreciação da máquina." />
      </div>
    </ModalForm>}
    {edit && editingRate && data && <ModalForm title="Tarifa de energia" subtitle="Vale para as próximas produções." close={() => setEditingRate(false)} label="Salvar tarifa"
      action={async values => {
        await api('production/energy-rate', fields(values), 'PUT');
        await done('Tarifa atualizada.');
      }}>
      <Field name="energyRate" label="Valor por kWh (R$)" inputMode="decimal" placeholder="0,90" defaultValue={data.energyRate}
        hint="Use o valor com impostos da sua conta de luz." />
    </ModalForm>}
    {edit && status && <ModalForm title={(status.active ? 'Inativar ' : 'Reativar ') + status.name} label={status.active ? 'Inativar' : 'Reativar'} danger={status.active}
      close={() => setStatus(undefined)} action={async () => {
        await api('production/printers/' + status.id + '/status', { active: !status.active });
        await done(status.name + (status.active ? ' inativada.' : ' reativada.'));
      }}>
      <p className="muted">{status.active ? 'A impressora deixa de aparecer para novas produções.' : 'A impressora volta a aparecer para novas produções.'}</p>
    </ModalForm>}
    {edit && removal?.deleteBlock && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.deleteBlock} Se ela saiu de uso, use Inativar para preservar o histórico.</p>
    </Modal>}
    {edit && removal && !removal.deleteBlock && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger close={() => setRemoval(undefined)} action={async () => {
      await api('production/printers/' + removal.id, undefined, 'DELETE');
      await done(removal.name + ' excluída.');
    }}>
      <p className="muted">Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}
