import { ChangeEvent, useCallback, useRef, useState } from 'react';
import { FileText, ImageIcon, Trash2, Undo2, Upload } from 'lucide-react';
import { PdfViewer } from './order-pdf';
import { loadReportImage, Report, ReportBrand } from './pdf';
import { maxImageBytes, usePreview } from './product-image';
import { api, brl, dateTime, Field, fields, Form, Loading, message, notify, PageActions, Section, useData } from './ui';

export type Company = {
  name: string; tagline: string | null; contact: string | null; footer: string | null; quoteValidityDays: number;
  logoFileId: string | null; logoName: string | null;
};
/** The file id in the address makes the browser ask again when the logo is replaced. */
export const companyLogoUrl = (company: Pick<Company, 'logoFileId'>) => company.logoFileId ? '/api/company/logo?v=' + company.logoFileId : null;

/** The letterhead of a report, with the logo read from the panel. */
export async function companyBrand(company: Company): Promise<ReportBrand> {
  const url = companyLogoUrl(company);
  return { name: company.name || 'Sua empresa', tagline: company.tagline, contact: company.contact, logo: url ? await loadReportImage(url) : null };
}

/** A sample document, so the letterhead can be checked before the first quote. */
export async function companySample(company: Company): Promise<Report> {
  return {
    title: 'Orçamento', status: 'Exemplo', generated: 'Emitido em ' + dateTime(new Date().toISOString()), brand: await companyBrand(company), footer: company.footer,
    sections: [
      { heading: 'Cliente', fields: [['Nome', 'Nome do cliente'], ['Contato', '(00) 00000-0000']] },
      { heading: 'Pedido', table: { columns: [{ label: 'Descrição', weight: 1 }, { label: 'Detalhes', weight: 2 }], rows: [
        ['Produto', 'Estatueta decorativa'], ['Quantidade', '32 unidades'], ['Prazo de entrega', '7 dias'],
      ] } },
      { heading: 'Valores', total: { lines: [['Valor por unidade', brl('16')], ['Quantidade', '32']], label: 'VALOR TOTAL', value: brl('512') },
        notes: ['Válido por ' + company.quoteValidityDays + (company.quoteValidityDays === 1 ? ' dia.' : ' dias.')] },
    ],
  };
}

function TextArea({ name, label, defaultValue, placeholder, hint }: { name: string; label: string; defaultValue?: string; placeholder?: string; hint?: string }) {
  return <label>{label}<textarea name={name} rows={3} maxLength={500} defaultValue={defaultValue} placeholder={placeholder} />
    {hint && <span className="hint">{hint}</span>}</label>;
}

/** The letterhead of the documents sent to customers: one record, edited in place. */
export function CompanySettings({ edit }: { edit: boolean }) {
  const { data, error, loading, reload } = useData<Company>('company');
  // A new logo waits here until the save; `null` asks the save to remove the current one.
  const [logo, setLogo] = useState<File | null | undefined>();
  const [failure, setFailure] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = usePreview(logo ?? null);
  const current = data && logo === undefined ? companyLogoUrl(data) : null;
  const [previewing, setPreviewing] = useState(false);
  const sample = useCallback(() => companySample(data!), [data]);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxImageBytes) { setFailure('A imagem passa do limite de 5 MB.'); return; }
    setFailure('');
    setLogo(file);
  }

  async function save(values: FormData) {
    const { name, tagline, contact, footer, quoteValidityDays } = fields(values);
    let logoFileId: string | null | undefined = logo === null ? null : undefined;
    if (logo) {
      const body = new FormData();
      body.append('file', logo);
      logoFileId = (await api<{ id: string }>('company/uploads/logo', body)).id;
    }
    await api('company', { name, tagline, contact, footer, quoteValidityDays, ...(logoFileId === undefined ? {} : { logoFileId }) }, 'PUT');
    setLogo(undefined);
    notify('Dados da empresa salvos.');
    await reload();
  }

  return <>
    {data && <PageActions><button type="button" className="btn secondary" onClick={() => setPreviewing(true)}>
      <FileText size={16} aria-hidden="true" />Prévia do PDF</button></PageActions>}
    {previewing && data && <PdfViewer title="Prévia do cabeçalho" subtitle="Um orçamento de exemplo com os dados salvos." fileName="previa-orcamento.pdf"
      build={sample} close={() => setPreviewing(false)} />}
    {message(error)}
    {!data ? loading && <Loading label="Carregando dados da empresa…" /> : <Section title="Dados da empresa"
      subtitle="Aparecem no cabeçalho e no rodapé dos orçamentos enviados aos clientes.">
      <Form key={data.logoFileId + data.name} label="Salvar" disabled={!edit} action={save}>
        <section className="preview-box">
          <div className="section-head">
            <h3>Logo</h3>
            {edit && <div className="actions">
              <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="Escolher logo" onChange={pick} />
              <button type="button" className="btn secondary small" onClick={() => input.current?.click()}>
                <Upload size={14} aria-hidden="true" />{pending || current ? 'Trocar logo' : 'Escolher logo'}</button>
              {logo !== undefined && <button type="button" className="btn ghost small" onClick={() => setLogo(undefined)}><Undo2 size={14} aria-hidden="true" />Desfazer</button>}
              {logo === undefined && current && <button type="button" className="btn ghost small" onClick={() => setLogo(null)}>
                <Trash2 size={14} aria-hidden="true" />Remover</button>}
            </div>}
          </div>
          <p className="hint">JPG, PNG ou WebP, até 5 MB. Prefira uma imagem larga com fundo transparente.
            {logo && ' O novo logo é enviado ao salvar.'}{logo === null && ' O logo será removido ao salvar.'}</p>
          {message(failure)}
          {pending || current ? <img className="product-image-preview" src={pending ?? current!} alt={'Logo de ' + (data.name || 'sua empresa')} />
            : <p className="muted"><ImageIcon size={16} aria-hidden="true" /> Sem logo. O nome da empresa aparece sozinho no cabeçalho.</p>}
        </section>
        <div className="form-grid">
          <Field name="name" label="Nome da empresa" placeholder="Ex.: Lar&Stock3D" defaultValue={data.name} />
          <Field name="tagline" label="Slogan" required={false} placeholder="Ex.: Impressão 3D sob medida" defaultValue={data.tagline ?? undefined} />
        </div>
        <TextArea name="contact" label="Contato" placeholder="Telefone, e-mail, site ou redes sociais" defaultValue={data.contact ?? undefined}
          hint="Aparece abaixo do nome, no cabeçalho." />
        <TextArea name="footer" label="Rodapé" placeholder="Ex.: Pagamento via Pix. Obrigado pela preferência!" defaultValue={data.footer ?? undefined}
          hint="Aparece no fim de cada orçamento." />
        <Field name="quoteValidityDays" label="Validade do orçamento (dias)" inputMode="numeric" defaultValue={String(data.quoteValidityDays)}
          hint="Sugerida ao criar um orçamento." />
      </Form>
    </Section>}
  </>;
}
