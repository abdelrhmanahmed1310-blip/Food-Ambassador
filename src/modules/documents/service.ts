import "server-only";
import { getSalesInvoice } from "@/modules/b2b/service";
import { companyContext } from "@/modules/fx/service";
import { getOrder } from "@/modules/procurement/orders";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";

/**
 * Data for printable documents (DECISIONS.md ADR-089). Each one is read
 * through the same service as its page, so the same permissions apply; the
 * PDF layout itself is in src/server/pdf.
 */

export interface Letterhead {
  legalName: string;
  vatNumber: string | null;
  crNumber: string | null;
  /** The national address from the company's e-invoicing details, when set. */
  address: string[];
}

/** The issuing company as it appears on documents (ADR-082/084/085). */
export async function letterheadInTx(
  tx: Tx,
  ctx: TenantContext,
  companyId: string | null,
): Promise<Letterhead> {
  const company = await tx.company.findFirst({
    where: {
      organizationId: ctx.organizationId,
      ...(companyId ? { id: companyId } : { isDefault: true }),
    },
    select: {
      id: true,
      name: true,
      legalName: true,
      vatRegistered: true,
      vatNumber: true,
      crNumber: true,
    },
  });
  if (!company)
    return { legalName: ctx.organizationName, vatNumber: null, crNumber: null, address: [] };
  const z = await tx.zatcaSettings.findUnique({
    where: {
      organizationId_companyId: { organizationId: ctx.organizationId, companyId: company.id },
    },
  });
  return {
    // The seller name registered for e-invoicing, when set, so every document agrees with ZATCA.
    legalName: z?.legalName ?? company.legalName,
    vatNumber: company.vatRegistered ? company.vatNumber : null,
    crNumber: z?.crNumber ?? company.crNumber,
    address: z ? [`${z.building} ${z.street}, ${z.district}`, `${z.city} ${z.postalCode}`] : [],
  };
}

/** A purchase order to send to the supplier. */
export async function purchaseOrderForPrint(ctx: TenantContext, orderId: string) {
  const order = await getOrder(ctx, orderId);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    order,
    supplier: await tx.supplier.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: order.supplierId },
      select: { code: true, name: true, taxId: true, address: true, phone: true, email: true },
    }),
    seller: await letterheadInTx(tx, ctx, order.companyId),
  }));
}

/** A B2B sales invoice for the customer. */
export async function salesInvoiceForPrint(ctx: TenantContext, invoiceId: string) {
  const invoice = await getSalesInvoice(ctx, invoiceId);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    invoice,
    seller: await letterheadInTx(tx, ctx, invoice.companyId),
  }));
}

/** The company that owns a warehouse, as letterhead (requests for quotation, ADR-092). */
export async function letterheadForWarehouse(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { companyId } = await companyContext(tx, ctx, { warehouseId });
    return letterheadInTx(tx, ctx, companyId);
  });
}
