ALTER TABLE "AuditEvent" ADD COLUMN "details" JSONB;

CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- The audit now records only changes and security events.
DELETE FROM "AuditEvent"
WHERE "action" LIKE 'Consultar%'
   OR "action" LIKE 'Baixar%'
   OR "action" LIKE 'Preparar%'
   OR "action" IN ('Enviar planilha de inventário', 'Sair');
