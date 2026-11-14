import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Database, dayRange, idField, parse } from '../shared';

const filterFields = z.object({
  cursor: idField.optional(),
  userId: idField.optional(),
  action: z.string().trim().min(1).max(160).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  result: z.enum(['success', 'denied', 'error']).optional(),
});

const results: Record<string, Prisma.AuditEventWhereInput> = {
  success: { status: { lt: 400 } },
  denied: { status: { in: [401, 403] } },
  error: { OR: [{ status: null }, { status: { gte: 400, notIn: [401, 403] } }] },
};

@Controller('audit')
export class AuditController {
  constructor(@Inject(Database) private db: Database) {}

  @Require('admin')
  @Get()
  async list(@Query() query: unknown) {
    const { cursor, userId, action, from, to, result } = parse(filterFields, query);
    const events = await this.db.auditEvent.findMany({
      where: { actorId: userId, action, createdAt: dayRange(from, to), ...(result ? results[result] : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { events: events.slice(0, 50), nextCursor: events.length > 50 ? events[49].id : null };
  }

  @Require('admin')
  @Get('filters')
  async filters() {
    const [actions, users] = await Promise.all([
      this.db.auditEvent.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.db.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return { actions: actions.map(row => row.action), users };
  }
}
