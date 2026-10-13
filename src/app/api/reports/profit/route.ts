import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDb } from "@/lib/server/db";
import { Transaction } from "@/lib/server/models/Transaction";
import { Purchase } from "@/lib/server/models/Purchase";
import { Expense } from "@/lib/server/models/Expense";
import { Product } from "@/lib/server/models/Product";
import { getAuth, resolveBranchScope } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Management / profit overview — NOT full accounting.
//   Revenue            = sum of SUCCESS sales in range
//   Cost of goods SOLD = cost of the units actually sold in range, valued at
//                        the weighted-average buying price per product. This is
//                        deliberately NOT "all stock bought in the period":
//                        unsold stock sitting in a branch is inventory, not an
//                        expense yet (Test report F-07). FIFO lot-level costing
//                        is a later enhancement; weighted-average is a faithful
//                        approximation that no longer counts unsold purchases.
//   Gross profit       = Revenue - Cost of goods sold
//   Stock purchased    = total spent restocking in range (cash out, shown
//                        separately so owners still see buying activity)
//   Expenses           = operating expenses in range
//   Net profit         = Gross profit - Expenses
export async function GET(req: NextRequest) {
  await connectDb();
  const auth = getAuth(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const branchId = resolveBranchScope(auth, url.searchParams.get("branchId"));

  // Default range: start of the current month -> now.
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : defaultFrom;
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : now;

  // F-03: reject a reversed / invalid date range instead of silently
  // returning an empty report.
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return NextResponse.json({ error: "Please provide valid report dates." }, { status: 400 });
  }
  if (from.getTime() > to.getTime()) {
    return NextResponse.json(
      { error: "The start date must be on or before the end date." },
      { status: 400 }
    );
  }

  const branchObjId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
  const businessObjId = new mongoose.Types.ObjectId(auth.businessId);
  const dateMatch = { createdAt: { $gte: from, $lte: to } };

  const salesMatch: Record<string, unknown> = { ...dateMatch, businessId: businessObjId, paymentStatus: "SUCCESS" };
  if (branchObjId) salesMatch.branchId = branchObjId;

  const costMatch: Record<string, unknown> = { ...dateMatch, businessId: businessObjId };
  if (branchObjId) costMatch.branchId = branchObjId;

  // All-time scope (business + optional branch) used to value cost of goods
  // sold and to compute current stock on hand.
  const scopeMatch: Record<string, unknown> = { businessId: businessObjId };
  if (branchObjId) scopeMatch.branchId = branchObjId;
  const soldAllMatch: Record<string, unknown> = { businessId: businessObjId, paymentStatus: "SUCCESS" };
  if (branchObjId) soldAllMatch.branchId = branchObjId;

  const [salesAgg, purchaseAgg, expenseAgg, soldInRange, avgCostByProduct, purchasedAll, soldAll, products] =
    await Promise.all([
      Transaction.aggregate([
        { $match: salesMatch },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amountTotal" },
            cashTotal: { $sum: { $cond: [{ $eq: ["$paymentMethod", "CASH"] }, "$amountTotal", 0] } },
            mpesaTotal: { $sum: { $cond: [{ $eq: ["$paymentMethod", "MPESA"] }, "$amountTotal", 0] } },
            salesCount: { $sum: 1 },
          },
        },
      ]),
      Purchase.aggregate([
        { $match: costMatch },
        { $group: { _id: null, stockPurchased: { $sum: "$totalCost" }, purchaseCount: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: costMatch },
        { $group: { _id: null, expenses: { $sum: "$amount" }, expenseCount: { $sum: 1 } } },
      ]),
      // Units sold per product within the report range (SUCCESS only).
      Transaction.aggregate([
        { $match: salesMatch },
        { $group: { _id: "$productId", qty: { $sum: "$quantity" } } },
      ]),
      // Weighted-average buying cost per product across ALL purchases in scope.
      Purchase.aggregate([
        { $match: scopeMatch },
        { $group: { _id: "$productId", totalCost: { $sum: "$totalCost" }, totalQty: { $sum: "$quantity" } } },
      ]),
      // All-time purchased quantity per product (for current stock on hand).
      Purchase.aggregate([
        { $match: scopeMatch },
        { $group: { _id: "$productId", qty: { $sum: "$quantity" } } },
      ]),
      // All-time sold quantity per product (SUCCESS only).
      Transaction.aggregate([
        { $match: soldAllMatch },
        { $group: { _id: "$productId", qty: { $sum: "$quantity" } } },
      ]),
      Product.find({ businessId: businessObjId }).select("label unit").lean(),
    ]);

  // Build a product-id -> weighted avg cost map.
  const avgCost = new Map<string, number>();
  for (const row of avgCostByProduct as { _id: unknown; totalCost: number; totalQty: number }[]) {
    if (!row._id) continue;
    const avg = row.totalQty > 0 ? row.totalCost / row.totalQty : 0;
    avgCost.set(String(row._id), avg);
  }

  // Cost of goods SOLD = sum over products of (units sold in range * avg cost).
  let costOfGoodsSold = 0;
  for (const row of soldInRange as { _id: unknown; qty: number }[]) {
    if (!row._id) continue;
    costOfGoodsSold += (row.qty || 0) * (avgCost.get(String(row._id)) ?? 0);
  }
  costOfGoodsSold = Math.round(costOfGoodsSold);

  // Current stock on hand per product = all-time purchased - all-time sold.
  const productMeta = new Map<string, { label: string; unit: string }>();
  for (const p of products as { _id: unknown; label: string; unit?: string }[]) {
    productMeta.set(String(p._id), { label: p.label, unit: p.unit || "" });
  }
  const onHandMap = new Map<string, number>();
  for (const row of purchasedAll as { _id: unknown; qty: number }[]) {
    if (!row._id) continue;
    onHandMap.set(String(row._id), (onHandMap.get(String(row._id)) ?? 0) + (row.qty || 0));
  }
  for (const row of soldAll as { _id: unknown; qty: number }[]) {
    if (!row._id) continue;
    onHandMap.set(String(row._id), (onHandMap.get(String(row._id)) ?? 0) - (row.qty || 0));
  }
  const stockOnHand = Array.from(onHandMap.entries())
    .map(([productId, quantity]) => ({
      productId,
      label: productMeta.get(productId)?.label ?? "(removed product)",
      unit: productMeta.get(productId)?.unit ?? "",
      quantity,
    }))
    .filter((s) => productMeta.has(s.productId)) // only live/known products
    .sort((a, b) => a.label.localeCompare(b.label));

  const revenue = salesAgg[0]?.revenue ?? 0;
  const stockPurchased = purchaseAgg[0]?.stockPurchased ?? 0;
  const expenses = expenseAgg[0]?.expenses ?? 0;
  const grossProfit = revenue - costOfGoodsSold;
  const netProfit = grossProfit - expenses;

  return NextResponse.json({
    scope: branchId ? "branch" : "global",
    range: { from: from.toISOString(), to: to.toISOString() },
    revenue,
    cashTotal: salesAgg[0]?.cashTotal ?? 0,
    mpesaTotal: salesAgg[0]?.mpesaTotal ?? 0,
    salesCount: salesAgg[0]?.salesCount ?? 0,
    // Cost of goods SOLD (not all stock purchased). `costOfGoods` kept as an
    // alias for backward compatibility with any existing clients.
    costOfGoodsSold,
    costOfGoods: costOfGoodsSold,
    stockPurchased,
    purchaseCount: purchaseAgg[0]?.purchaseCount ?? 0,
    grossProfit,
    expenses,
    expenseCount: expenseAgg[0]?.expenseCount ?? 0,
    netProfit,
    stockOnHand,
  });
}
