-- Recalls flag lots (ADR-034). Lots are otherwise immutable for the
-- application role, so only the recall_hold column becomes updatable.
GRANT UPDATE ("recall_hold") ON "inventory_lots" TO fa_tenant;
