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
import { FileMaintenance, FileService, ProductFilesController, ProductImageController } from './files/files';
import { DiskFileStorage, FileStorage } from './files/storage';
import { BankConnectionService } from './finance/connection';
import { FinanceController, FinanceService } from './finance/finance';
import { HealthController } from './health';
import { ProductionCorrectionController, ProductionCorrectionService } from './production/corrections';
import { ProductionOrderController, ProductionOrderService } from './production/orders';
import { PaymentMethodController, PaymentMethodService } from './production/payments';
import { ProductionController, ProductionService } from './production/production';
import { PurchaseDocumentController, PurchaseDocumentSearch, PurchaseDocumentSearchController, PurchaseDocumentService } from './purchases/documents';
import { PurchaseController, PurchaseService } from './purchases/purchases';
import { CostItemController, CostItemService } from './registrations/costs';
import { SupplierController, SupplierService } from './purchases/suppliers';
import { Database, DatabaseErrors } from './shared';
import { StockController } from './stock/controller';
import { PreviewCleanup, StockService } from './stock/stock';

@Global()
@Module({ providers: [Database], exports: [Database] })
class PersistenceModule {}

@Module({ controllers: [AccessController], providers: [AccessService, SessionCleanup, { provide: APP_GUARD, useClass: AccessGuard }] })
class AccessModule {}

@Module({
  controllers: [ProductFilesController, ProductImageController],
  providers: [FileService, FileMaintenance, { provide: FileStorage, useClass: DiskFileStorage }],
  exports: [FileService],
})
class FilesModule {}

@Module({ imports: [FilesModule], controllers: [CatalogController, RecipeController], providers: [CatalogService, RecipeService], exports: [CatalogService] })
class CatalogModule {}

@Module({ imports: [CatalogModule], controllers: [StockController], providers: [StockService, PreviewCleanup], exports: [StockService] })
class StockModule {}

@Module({ controllers: [FinanceController], providers: [FinanceService, BankConnectionService] })
class FinanceModule {}

@Module({
  imports: [StockModule], controllers: [ProductionController, ProductionCorrectionController, ProductionOrderController, PaymentMethodController],
  providers: [ProductionService, ProductionOrderService, ProductionCorrectionService, PaymentMethodService],
})
class ProductionModule {}

@Module({
  imports: [StockModule, FilesModule], controllers: [PurchaseController, PurchaseDocumentController, PurchaseDocumentSearchController, SupplierController],
  providers: [PurchaseService, PurchaseDocumentService, PurchaseDocumentSearch, SupplierService],
})
class PurchasesModule {}

@Module({ controllers: [CostItemController], providers: [CostItemService] })
class RegistrationsModule {}

@Module({ controllers: [AuditController], providers: [AuditRetention] })
class AuditModule {}

@Module({
  imports: [PersistenceModule, AccessModule, CatalogModule, StockModule, FinanceModule, ProductionModule, PurchasesModule, RegistrationsModule, AuditModule],
  controllers: [HealthController],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  // The default of 5 minutes would cut a 100 MB attachment on a slow connection.
  app.getHttpServer().requestTimeout = 30 * 60 * 1000;
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
