-- ordered_at is set when a line is met by a purchase order line or by a shipment (ADR-046).
ALTER TABLE "purchase_requisition_lines" DROP CONSTRAINT "purchase_requisition_lines_quantities_ck";
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_quantities_ck"
  CHECK ("quantity" > 0 AND "quantity_base" > 0 AND "line_no" > 0
         AND (("purchase_order_line_id" IS NULL AND "shipment_id" IS NULL) = ("ordered_at" IS NULL)));
