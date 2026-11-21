import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AccessController, AccessGuard, AccessService, SessionCleanup } from './access/access';
import { proxySetting } from './access/attempts';
import { AuditController } from './audit/audit';
import { AuditInterceptor, AuditRetention } from './audit/recorder';
import { CatalogController, CatalogService } from './catalog/catalog';
import { RecipeController, RecipeService } from './catalog/recipe';
import { BankConnectionService } from './finance/connection';
import { FinanceController, FinanceService } from './finance/finance';
import { HealthController } from './health';
import { ProductionOrderController, ProductionOrderService } from './production/orders';
import { ProductionController, ProductionService } from './production/production';
import { Database, DatabaseErrors } from './shared';
import { StockController } from './stock/controller';
import { PreviewCleanup, StockService } from './stock/stock';

@Global()
@Module({ providers: [Database], exports: [Database] })
class PersistenceModule {}

@Module({ controllers: [AccessController], providers: [AccessService, SessionCleanup, { provide: APP_GUARD, useClass: AccessGuard }] })
class AccessModule {}

@Module({ controllers: [CatalogController, RecipeController], providers: [CatalogService, RecipeService], exports: [CatalogService] })
class CatalogModule {}

@Module({ imports: [CatalogModule], controllers: [StockController], providers: [StockService, PreviewCleanup], exports: [StockService] })
class StockModule {}

@Module({ controllers: [FinanceController], providers: [FinanceService, BankConnectionService] })
class FinanceModule {}

@Module({
  imports: [StockModule], controllers: [ProductionController, ProductionOrderController], providers: [ProductionService, ProductionOrderService],
})
class ProductionModule {}

@Module({ controllers: [AuditController], providers: [AuditRetention] })
class AuditModule {}

@Module({
  imports: [PersistenceModule, AccessModule, CatalogModule, StockModule, FinanceModule, ProductionModule, AuditModule],
  controllers: [HealthController],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new DatabaseErrors());
  app.useGlobalInterceptors(new AuditInterceptor());
  app.use('/api', (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Behind the HTTPS proxy, the client address comes from X-Forwarded-For.
  const trustProxy = proxySetting();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  const web = resolve(__dirname, '../web');
  if (existsSync(resolve(web, 'index.html'))) app.useStaticAssets(web);
  return app;
}

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
  console.log('LeS Manager em http://localhost:' + port);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
