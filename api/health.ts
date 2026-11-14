import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './access/access';
import { Database } from './shared';

/** Liveness check for containers and proxies. Confirms that the database answers. */
@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private db: Database) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Banco de dados indisponível.');
    }
    return { ok: true };
  }
}
