import { CallHandler, Controller, ExecutionContext, Get, Inject, Injectable, NestInterceptor, Query, Req } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { concatMap } from 'rxjs';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Database, idField, parse } from '../shared';

const routes: Record<string, string> = {
  'POST /access/login': 'Entrar', 'POST /access/logout': 'Sair',
  'POST /access/activate': 'Ativar conta', 'GET /access/me': 'Consultar própria conta',
  'PATCH /access/me': 'Alterar próprio nome', 'POST /access/me/password': 'Alterar própria senha',
  'GET /access/profiles': 'Consultar perfis', 'POST /access/profiles': 'Criar perfil',
  'PATCH /access/profiles/:id': 'Alterar perfil',
  'GET /access/users': 'Consultar usuários', 'POST /access/users': 'Criar usuário',
  'PATCH /access/users/:id': 'Alterar usuário', 'POST /access/users/:id/code': 'Gerar código de acesso',
  'GET /catalog': 'Consultar catálogo', 'GET /catalog/registrations': 'Consultar cadastros',
  'POST /catalog/references': 'Criar classificação', 'PATCH /catalog/references/:id': 'Alterar classificação',
  'POST /catalog/families': 'Criar família de medida', 'POST /catalog/units': 'Criar unidade',
  'POST /catalog/products': 'Criar produto', 'PATCH /catalog/products/:id': 'Alterar produto',
  'POST /catalog/kits': 'Criar kit', 'PATCH /catalog/kits/:id': 'Alterar kit',
  'GET /stock': 'Consultar estoque', 'GET /stock/movements': 'Consultar movimentações',
  'POST /stock/movements': 'Registrar movimentação', 'POST /stock/kits/:id/out': 'Registrar saída de kit',
  'GET /stock/inventory/template': 'Baixar modelo de inventário',
  'POST /stock/inventory/preview': 'Preparar inventário', 'POST /stock/inventory/upload': 'Enviar planilha de inventário',
  'POST /stock/inventory/:id/confirm': 'Confirmar inventário',
  'GET /stock/initial/template': 'Baixar modelo de carga inicial', 'POST /stock/initial/preview': 'Preparar carga inicial',
  'POST /stock/initial/:id/confirm': 'Confirmar carga inicial',
  'GET /finance/providers': 'Consultar provedores bancários', 'GET /finance/balance': 'Consultar saldo',
  'GET /finance': 'Consultar extrato', 'POST /finance/refresh': 'Sincronizar dados bancários',
  'POST /finance/reconciliation': 'Alterar conciliação bancária', 'GET /audit': 'Consultar auditoria',
};

export function auditRequests(db: Database) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const path = request.path.toLowerCase().replace(/\/$/, '');
    const dynamic = path.match(/^\/(access\/(?:profiles|users)|catalog\/(?:references|products|kits)|stock\/(?:kits|inventory|initial))\/([^/]+)(\/[^/]+)?$/);
    const normalized = dynamic ? '/' + dynamic[1] + '/:id' + (dynamic[3] ?? '') : path;
    const action = routes[method + ' ' + path] ?? routes[method + ' ' + normalized];
    if (!action) return next();

    try {
      let targetId: string | undefined;
      if (dynamic) {
        try {
          const decoded = decodeURIComponent(dynamic[2]);
          if (idField.safeParse(decoded).success) targetId = decoded.toLowerCase();
        } catch { /* The handler validates malformed identifiers. */ }
      }
      const { id } = await db.auditEvent.create({ data: { action, targetId }, select: { id: true } });
      response.locals.auditId = id;
      let finalized = false;
      async function finalize(status: number, result?: unknown) {
        if (finalized) return;
        finalized = true;
        const actor = (request as Partial<Authenticated>).identity ?? response.locals.auditActor;
        const resultId = result && typeof result === 'object' && 'id' in result ? idField.safeParse(result.id) : undefined;
        await db.auditEvent.update({
          where: { id },
          data: { status, completedAt: new Date(), actorId: actor?.id, actorName: actor?.name,
            targetId: targetId ?? response.locals.auditTarget ?? (resultId?.success ? resultId.data : undefined) },
        }).catch(() => console.error('Falha ao concluir evento de auditoria.'));
      }
      response.locals.finalizeAudit = finalize;
      response.once('finish', () => { void finalize(response.statusCode); });
      response.once('close', () => { void finalize(499); });
      next();
    } catch {
      response.status(503).json({ message: 'Auditoria indisponível. Tente novamente.' });
    }
  };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    const finalize = response.locals.finalizeAudit as ((status: number, result: unknown) => Promise<void>) | undefined;
    if (!finalize) return next.handle();
    return next.handle().pipe(concatMap(result => finalize(response.statusCode, result).then(() => result)));
  }
}

@Controller('audit')
export class AuditController {
  constructor(@Inject(Database) private db: Database) {}

  @Require('admin')
  @Get()
  async list(@Req() request: Request, @Query() query: unknown) {
    const { cursor } = parse(z.object({ cursor: idField.optional() }), query);
    const events = await this.db.auditEvent.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: { id: { not: request.res?.locals.auditId } },
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { events: events.slice(0, 50), nextCursor: events.length > 50 ? events[49].id : null };
  }
}
