import {
  Body, CanActivate, ConflictException, Controller, ExecutionContext, ForbiddenException, Get,
  HttpCode, HttpException, Inject, Injectable, NotFoundException, Param, Patch, Post, Req, Res,
  SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Audit, AUDIT, auditActor, auditChange, auditContext, beginAudit } from '../audit/recorder';
import { Database, idField, nameField, parse, serial } from '../shared';
import {
  activationFields, administrator, canAccess, configurablePermissions, emailField, hashPassword,
  hashToken, newToken, passwordChangeFields, verifyPassword,
} from './security';

export const Require = (...permissions: string[]) => SetMetadata('permissions', permissions);
const Public = () => SetMetadata('public', true);
const cookieName = 'les_session';
const sessionAge = 8 * 60 * 60 * 1000;
const activationAge = 24 * 60 * 60 * 1000;
type Identity = { id: string; name: string; email: string; profileName: string; permissions: string[] };
export type Authenticated = Request & { identity: Identity };
const loginFields = z.object({ email: emailField, password: z.string().min(1).max(128) });
const profileFields = z.object({
  name: nameField,
  permissions: z.array(z.string().refine(permission => configurablePermissions.includes(permission))).max(configurablePermissions.length),
});
const userFields = z.object({ name: nameField, email: emailField, profileId: idField });
const userUpdate = z.object({ name: nameField, profileId: idField, active: z.boolean() });
const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/api', secure: process.env.COOKIE_SECURE === 'true' };

function sessionToken(request: Request) {
  return request.headers.cookie?.match(/(?:^|;\s*)les_session=([A-Za-z0-9_-]{32})(?:;|$)/)?.[1];
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(Database) private db: Database, @Inject(Reflector) private reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Authenticated>();
    const action = this.reflector.get<string | false | undefined>(AUDIT, context.getHandler());
    if (action) await beginAudit(this.db, context, action);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException();
    }
    if (this.reflector.get('public', context.getHandler())) return true;
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException('Entre para continuar.');
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(token) }, include: { user: { include: { profile: true } } },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.active || !session.user.passwordHash) {
      throw new UnauthorizedException('Sessão expirada. Entre novamente.');
    }
    const { id, name, email, profile } = session.user;
    request.identity = { id, name, email, profileName: profile.name, permissions: profile.permissions };
    const required = this.reflector.get<string[]>('permissions', context.getHandler()) ?? [];
    if (!required.every(permission => canAccess(profile.permissions, permission))) throw new ForbiddenException('Seu perfil não tem acesso a esta operação.');
    return true;
  }
}

@Injectable()
export class AccessService {
  private attempts = new Map<string, { count: number; expires: number }>();
  constructor(@Inject(Database) private db: Database) {}

  limit(ip: string) {
    const now = Date.now();
    for (const [key, item] of this.attempts) if (item.expires <= now) this.attempts.delete(key);
    const item = this.attempts.get(ip) ?? { count: 0, expires: now + 60_000 };
    if (item.count >= 20) throw new HttpException('Muitas tentativas. Aguarde um minuto.', 429);
    item.count++;
    this.attempts.set(ip, item);
  }

  async login(data: z.infer<typeof loginFields>, response: Response) {
    auditContext({ 'E-mail': data.email });
    const user = await this.db.user.findUnique({ where: { email: data.email } });
    const valid = await verifyPassword(data.password, user?.passwordHash ?? null);
    if (!user?.active || !user.passwordHash || !valid) throw new UnauthorizedException('E-mail ou senha inválidos. Para ativar uma conta nova, use Primeiro acesso.');
    return this.openSession(user.id, user.passwordHash, response);
  }

  async activate(data: z.infer<typeof activationFields>, response: Response) {
    auditContext({ 'E-mail': data.email });
    const where = {
      email: data.email, active: true, passwordHash: null, activationHash: hashToken(data.code),
      activationExpires: { gt: new Date() },
    };
    const user = await this.db.user.findFirst({ where, select: { id: true } });
    if (!user) throw new UnauthorizedException('Código inválido ou expirado.');
    const passwordHash = await hashPassword(data.password);
    const changed = await this.db.user.updateMany({
      where: { ...where, activationExpires: { gt: new Date() } },
      data: { passwordHash, activationHash: null, activationExpires: null },
    });
    if (!changed.count) throw new UnauthorizedException('Código inválido ou expirado.');
    return this.openSession(user.id, passwordHash, response);
  }

  async logout(request: Request, response: Response) {
    const token = sessionToken(request);
    if (token) {
      await this.db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    response.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }

  private async openSession(userId: string, passwordHash: string, response: Response) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + sessionAge);
    const actor = await this.db.$transaction(async tx => {
      // Serialize session creation with password changes and account deactivation.
      const [user] = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT "id", "name" FROM "User"
        WHERE "id" = ${userId} AND "active" AND "passwordHash" = ${passwordHash} FOR UPDATE`;
      if (!user) throw new UnauthorizedException('A conta foi alterada. Entre novamente.');
      await tx.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
      await tx.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
      return user;
    });
    auditActor(actor);
    response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionAge });
    return { ok: true };
  }

  async changePassword(userId: string, data: z.infer<typeof passwordChangeFields>, response: Response) {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { active: true, passwordHash: true } });
    if (!user?.active || !user.passwordHash || !await verifyPassword(data.currentPassword, user.passwordHash)) {
      throw new ForbiddenException('Senha atual incorreta.');
    }
    const passwordHash = await hashPassword(data.password);
    await this.db.$transaction(async tx => {
      const result = await tx.user.updateMany({
        where: { id: userId, active: true, passwordHash: user.passwordHash }, data: { passwordHash },
      });
      if (!result.count) throw new ConflictException('A conta foi alterada. Entre novamente.');
      await tx.session.deleteMany({ where: { userId } });
    });
    response.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }

  async createUser(data: z.infer<typeof userFields>) {
    const { code, activationHash, activationExpires } = this.activation();
    const user = await this.db.user.create({
      data: { ...data, activationHash, activationExpires }, select: { id: true, profile: { select: { name: true } } },
    });
    auditChange(null, { Nome: data.name, 'E-mail': data.email, Perfil: user.profile.name });
    return { id: user.id, code, expiresAt: activationExpires };
  }

  async replaceCode(id: string) {
    const { code, activationHash, activationExpires } = this.activation();
    const result = await this.db.user.updateMany({ where: { id, active: true, passwordHash: null }, data: { activationHash, activationExpires } });
    if (!result.count) throw new ConflictException('A conta precisa estar ativa e aguardando o primeiro acesso.');
    return { code, expiresAt: activationExpires };
  }

  private activation() {
    const code = newToken();
    return { code, activationHash: hashToken(code), activationExpires: new Date(Date.now() + activationAge) };
  }
}

@Controller('access')
export class AccessController {
  constructor(@Inject(AccessService) private service: AccessService, @Inject(Database) private db: Database) {}

  @Public()
  @Audit('Entrar')
  @Post('login')
  @HttpCode(200)
  login(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    this.service.limit(request.ip ?? 'local');
    return this.service.login(parse(loginFields, body), response);
  }

  @Public()
  @Audit('Ativar conta')
  @Post('activate')
  @HttpCode(200)
  activate(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    this.service.limit(request.ip ?? 'local');
    return this.service.activate(parse(activationFields, body), response);
  }

  @Post('logout')
  @Audit(false)
  @Public()
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.service.logout(request, response);
  }

  @Get('me')
  me(@Req() request: Authenticated) { return request.identity; }

  @Audit('Alterar próprio nome')
  @Patch('me')
  async updateMe(@Req() request: Authenticated, @Body() body: unknown) {
    const data = parse(z.strictObject({ name: nameField }), body);
    auditChange({ Nome: request.identity.name }, { Nome: data.name });
    const updated = await this.db.user.updateMany({
      where: { id: request.identity.id, active: true }, data,
    });
    if (!updated.count) throw new UnauthorizedException('A conta foi alterada. Entre novamente.');
    return { ...request.identity, name: data.name };
  }

  @Audit('Alterar própria senha')
  @Post('me/password')
  @HttpCode(200)
  changePassword(@Req() request: Authenticated, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    this.service.limit(request.ip ?? 'local');
    return this.service.changePassword(request.identity.id, parse(passwordChangeFields, body), response);
  }

  @Require(administrator)
  @Get('profiles')
  profiles() { return this.db.profile.findMany({ orderBy: { name: 'asc' } }); }

  @Require(administrator)
  @Audit('Criar perfil')
  @Post('profiles')
  createProfile(@Body() body: unknown) {
    const data = parse(profileFields, body);
    auditChange(null, { Nome: data.name, 'Permissões': [...new Set(data.permissions)] });
    return this.db.profile.create({ data: { ...data, permissions: [...new Set(data.permissions)] } });
  }

  @Require(administrator)
  @Audit('Alterar perfil')
  @Patch('profiles/:id')
  async updateProfile(@Param('id') id: string, @Body() body: unknown) {
    const data = parse(profileFields, body);
    const profile = await this.db.profile.findUnique({ where: { id: parse(idField, id) } });
    if (!profile) throw new NotFoundException('Perfil não encontrado.');
    if (profile.permissions.includes(administrator)) throw new ForbiddenException('O perfil administrador é reservado.');
    auditChange({ Nome: profile.name, 'Permissões': profile.permissions }, { Nome: data.name, 'Permissões': [...new Set(data.permissions)] });
    return this.db.profile.update({ where: { id }, data: { ...data, permissions: [...new Set(data.permissions)] } });
  }

  @Require(administrator)
  @Get('users')
  async users() {
    const users = await this.db.user.findMany({
      select: { id: true, name: true, email: true, active: true, profileId: true, activationExpires: true, passwordHash: true },
      orderBy: { name: 'asc' },
    });
    return users.map(({ passwordHash, ...user }) => ({ ...user, pending: !passwordHash }));
  }

  @Require(administrator)
  @Audit('Criar usuário')
  @Post('users')
  createUser(@Body() body: unknown) { return this.service.createUser(parse(userFields, body)); }

  @Require(administrator)
  @Audit('Alterar usuário')
  @Patch('users/:id')
  async updateUser(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(userUpdate, body);
    const userId = parse(idField, id);
    return serial(this.db, async tx => {
      const actor = await tx.user.findUnique({ where: { id: request.identity.id }, include: { profile: true } });
      if (!actor?.active || !actor.profile.permissions.includes(administrator)) throw new ForbiddenException();
      const existing = await tx.user.findUnique({ where: { id: userId }, include: { profile: true } });
      if (!existing) throw new NotFoundException('Usuário não encontrado.');
      const profile = await tx.profile.findUnique({ where: { id: data.profileId } });
      if (!profile) throw new NotFoundException('Perfil não encontrado.');
      auditChange({ Nome: existing.name, Perfil: existing.profile.name, Ativo: existing.active },
        { Nome: data.name, Perfil: profile.name, Ativo: data.active });
      if (actor.id === userId && (!data.active || existing.profileId !== data.profileId)) {
        throw new ConflictException('Você precisa manter seu próprio acesso de administrador.');
      }
      await tx.user.update({ where: { id: userId }, data });
      if (existing.profileId !== data.profileId || !data.active) await tx.session.deleteMany({ where: { userId } });
      return { ok: true };
    });
  }

  @Require(administrator)
  @Audit('Gerar código de acesso')
  @Post('users/:id/code')
  replaceCode(@Param('id') id: string) { return this.service.replaceCode(parse(idField, id)); }
}
