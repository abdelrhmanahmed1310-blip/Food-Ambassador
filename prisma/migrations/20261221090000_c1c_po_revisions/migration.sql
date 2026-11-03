-- C1c purchase order revisions (ADR-093).

ALTER TABLE "purchase_orders" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_revision_ck" CHECK ("revision" >= 0);

CREATE TABLE "purchase_order_revisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_order_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_order_revisions_organization_id_id_key" ON "purchase_order_revisions"("organization_id", "id");
CREATE UNIQUE INDEX "purchase_order_revisions_organization_id_purchase_order_id__key" ON "purchase_order_revisions"("organization_id", "purchase_order_id", "revision");
ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_ck"
  CHECK ("revision" >= 0 AND length(btrim("reason")) > 0 AND jsonb_typeof("snapshot" -> 'lines') = 'array');

-- A kept version is the order's current one at that moment, and the order
-- moves on by exactly one, only once that version is kept.
CREATE FUNCTION po_revision_is_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "purchase_orders" o
                 WHERE o."organization_id" = NEW."organization_id"
                   AND o."id" = NEW."purchase_order_id" AND o."revision" = NEW."revision") THEN
    RAISE EXCEPTION 'a kept revision must be the order''s current version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_order_revisions_current" BEFORE INSERT ON "purchase_order_revisions"
  FOR EACH ROW EXECUTE FUNCTION po_revision_is_current();

CREATE FUNCTION po_revision_steps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revision" = OLD."revision" THEN RETURN NEW; END IF;
  IF NEW."revision" <> OLD."revision" + 1 OR NOT EXISTS (
       SELECT 1 FROM "purchase_order_revisions" r
       WHERE r."organization_id" = OLD."organization_id"
         AND r."purchase_order_id" = OLD."id" AND r."revision" = OLD."revision") THEN
    RAISE EXCEPTION 'an order is revised one version at a time, after keeping the current one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_orders_revision_steps" BEFORE UPDATE OF "revision" ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION po_revision_steps();

-- Goods received against a line fix its product, unit and price, and the line stays.
CREATE FUNCTION po_line_received_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."received_quantity_base" > 0 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'an order line with goods received cannot be removed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."product_id" <> OLD."product_id" OR NEW."uom_id" <> OLD."uom_id"
       OR NEW."unit_price" <> OLD."unit_price" THEN
      RAISE EXCEPTION 'an order line with goods received keeps its product, unit and price'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "purchase_order_lines_received_fixed" BEFORE UPDATE OR DELETE ON "purchase_order_lines"
  FOR EACH ROW EXECUTE FUNCTION po_line_received_fixed();

GRANT SELECT, INSERT ON "purchase_order_revisions" TO fa_tenant;
ALTER TABLE "purchase_order_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_order_revisions" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
