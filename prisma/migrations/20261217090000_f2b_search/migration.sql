-- Global search (ADR-088): trigram indexes for "contains" searches.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- DropIndex

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- CreateIndex
CREATE INDEX "customers_name_trgm" ON "customers" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "employees_first_name_trgm" ON "employees" USING GIN ("first_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "employees_last_name_trgm" ON "employees" USING GIN ("last_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "goods_receipts_number_trgm" ON "goods_receipts" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "inventory_documents_number_trgm" ON "inventory_documents" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "inventory_lots_lot_code_trgm" ON "inventory_lots" USING GIN ("lot_code" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "menu_items_name_trgm" ON "menu_items" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "pos_customers_name_trgm" ON "pos_customers" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "pos_orders_number_trgm" ON "pos_orders" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_sku_trgm" ON "products" USING GIN ("sku" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_name_en_trgm" ON "products" USING GIN ("name_en" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_name_ar_trgm" ON "products" USING GIN ("name_ar" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "purchase_orders_number_trgm" ON "purchase_orders" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "recipes_name_trgm" ON "recipes" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "sales_invoices_number_trgm" ON "sales_invoices" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "sales_orders_number_trgm" ON "sales_orders" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "supplier_invoices_number_trgm" ON "supplier_invoices" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "supplier_invoices_ref_trgm" ON "supplier_invoices" USING GIN ("supplier_invoice_no" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "suppliers_name_trgm" ON "suppliers" USING GIN ("name" gin_trgm_ops);

