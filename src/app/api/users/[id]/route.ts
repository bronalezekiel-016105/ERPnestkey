import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/server/db";
import { User } from "@/lib/server/models/User";
import { Business } from "@/lib/server/models/Business";
import { getAuth, requireRole } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  // Deactivate / reactivate a staff account. A deactivated user keeps all
  // their history but can no longer sign in (login already rejects inactive
  // accounts). This is the "remove a staff member" action (Test report F-06).
  isActive: z.boolean(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  await connectDb();
  const auth = getAuth(req);
  if (!requireRole(auth, "BRANCH_MANAGER", "SUPER_ADMIN")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  // You can never deactivate your own account.
  if (params.id === auth!.sub) {
    return NextResponse.json({ error: "You cannot deactivate your own account." }, { status: 400 });
  }

  const target = await User.findOne({ _id: params.id, businessId: auth!.businessId });
  if (!target) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  // The business owner can never be deactivated — it would orphan the tenant.
  const business = await Business.findById(auth!.businessId).select("ownerId").lean();
  if (business && target._id.toString() === business.ownerId?.toString()) {
    return NextResponse.json({ error: "The business owner account cannot be deactivated." }, { status: 400 });
  }

  // Branch managers may only toggle delivery staff in their own branch.
  if (auth!.role === "BRANCH_MANAGER") {
    if (target.role !== "DELIVERY") {
      return NextResponse.json({ error: "Branch managers may only manage delivery staff." }, { status: 403 });
    }
    if (!target.branchId || target.branchId.toString() !== auth!.branchId) {
      return NextResponse.json({ error: "Branch managers may only manage staff in their own branch." }, { status: 403 });
    }
  }

  target.isActive = parsed.data.isActive;
  await target.save();

  const obj: any = target.toObject();
  delete obj.passwordHash;
  return NextResponse.json({ user: obj });
}
