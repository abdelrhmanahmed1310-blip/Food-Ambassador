import { canSeeExpenses, exportExpensesCsv } from "@/modules/finance/expenses";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of the expenses shown (ADR-109). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/finance/expenses/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeExpenses(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  try {
    return exportResponse(
      request,
      await exportExpensesCsv(ctx, {
        from: sp.from,
        to: sp.to,
        branchId: sp.branch,
        categoryId: sp.category,
      }),
      "expenses.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
