import { Agent, request } from 'node:https';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const sandbox = 'https://cdpj-sandbox.partners.uatinter.co';
const production = 'https://cdpj.partners.bancointer.com.br';
const bankAmount = z.union([z.string(), z.number().max(Number.MAX_SAFE_INTEGER / 100).min(-Number.MAX_SAFE_INTEGER / 100)])
  .transform(value => String(value)).pipe(z.string().regex(/^-?\d{1,20}(?:\.\d{1,2}0*)?$/));
const entryFields = z.object({
  idTransacao: z.string().nullish(), dataTransacao: z.iso.date(), valor: bankAmount,
  tipoOperacao: z.string(), tipoTransacao: z.string(), titulo: z.string().nullish(), descricao: z.string().nullish(),
});
const pageFields = z.object({
  totalPaginas: z.number().int().nonnegative().max(1000), totalElementos: z.number().int().nonnegative(),
  transacoes: z.array(entryFields),
});
const tokenFields = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

export type BankEntry = { id: string | null; date: string; amount: string; direction: string; type: string; title: string; description: string };
export interface BankReader {
  balance(): Promise<string>;
  statement(from: string, to: string): Promise<BankEntry[]>;
}
type Transport = (path: string, headers?: Record<string, string>, body?: string) => Promise<unknown>;
type Config = { clientId: string; secret: string; account?: string };

function httpsTransport(host: string, agent: Agent): Transport {
  return (path, headers, body) => new Promise((resolve, reject) => {
    const req = request(new URL(path, host), { agent, method: body === undefined ? 'GET' : 'POST', headers }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('Inter retornou HTTP ' + res.statusCode));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) req.destroy(new Error('Resposta do Inter grande demais.'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Tempo limite do Inter.')));
    req.on('error', reject);
    req.end(body);
  });
}

export class InterReader implements BankReader {
  private token?: { value: string; expiresAt: number };
  constructor(private config: Config, private transport: Transport) {}

  static fromEnv() {
    const { INTER_ENV, INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT_PATH, INTER_KEY_PATH, INTER_ACCOUNT } = process.env;
    if (!INTER_CLIENT_ID || !INTER_CLIENT_SECRET || !INTER_CERT_PATH || !INTER_KEY_PATH) {
      throw new Error('Configure as credenciais e o certificado do Inter.');
    }
    if (INTER_ENV !== 'sandbox' && INTER_ENV !== 'production') throw new Error('Defina INTER_ENV como sandbox ou production.');
    const agent = new Agent({ cert: readFileSync(INTER_CERT_PATH), key: readFileSync(INTER_KEY_PATH), keepAlive: true });
    return new InterReader({ clientId: INTER_CLIENT_ID, secret: INTER_CLIENT_SECRET, account: INTER_ACCOUNT },
      httpsTransport(INTER_ENV === 'production' ? production : sandbox, agent));
  }

  private async get(path: string) {
    if (!this.token || this.token.expiresAt <= Date.now()) {
      const body = new URLSearchParams({
        client_id: this.config.clientId, client_secret: this.config.secret,
        grant_type: 'client_credentials', scope: 'extrato.read',
      }).toString();
      const token = tokenFields.parse(await this.transport('/oauth/v2/token', {
        'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)),
      }, body));
      this.token = { value: token.access_token, expiresAt: Date.now() + Math.max(0, token.expires_in - 30) * 1000 };
    }
    const headers: Record<string, string> = { authorization: 'Bearer ' + this.token.value };
    if (this.config.account) headers['x-conta-corrente'] = this.config.account;
    return this.transport('/banking/v2' + path, headers);
  }

  async balance() {
    return z.object({ disponivel: bankAmount }).parse(await this.get('/saldo')).disponivel;
  }

  async statement(from: string, to: string) {
    const rows: BankEntry[] = [];
    let pages: number | undefined;
    let expected: number | undefined;
    for (let page = 0; page < (pages ?? 1); page++) {
      const query = new URLSearchParams({ dataInicio: from, dataFim: to, pagina: String(page), tamanhoPagina: '50' });
      const result = pageFields.parse(await this.get('/extrato/completo?' + query));
      if (pages !== undefined && (pages !== result.totalPaginas || expected !== result.totalElementos)) {
        throw new Error('Extrato alterado durante a leitura.');
      }
      pages = result.totalPaginas;
      expected = result.totalElementos;
      for (const row of result.transacoes) {
        if (row.dataTransacao < from || row.dataTransacao > to) throw new Error('Lançamento fora do período.');
        rows.push({
          id: row.idTransacao || null, date: row.dataTransacao, amount: row.valor, direction: row.tipoOperacao,
          type: row.tipoTransacao, title: row.titulo ?? '', description: row.descricao ?? '',
        });
      }
    }
    if (rows.length !== expected) throw new Error('Extrato incompleto.');
    return rows;
  }
}
