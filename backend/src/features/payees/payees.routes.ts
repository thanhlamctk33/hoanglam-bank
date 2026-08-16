import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";

const router = Router();
router.use(requireAuth);

// Saved ahead of time, unlike "Recent recipients" on the Transfer page which
// is derived after the fact from transaction history — this is how a
// company names a recipient before ever sending them money.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const payees = await prisma.savedPayee.findMany({
      where: { companyId: req.companyId },
      orderBy: { nickname: "asc" },
    });
    res.json({ payees });
  })
);

const createSchema = z.object({
  nickname: z.string().min(1).max(60),
  accountNumber: z.string().min(1).max(60),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const existing = await prisma.savedPayee.findFirst({
      where: { companyId: req.companyId, accountNumber: parsed.data.accountNumber },
    });
    if (existing) {
      throw new ConflictError("This account number is already saved");
    }

    const payee = await prisma.savedPayee.create({
      data: {
        companyId: req.companyId!,
        nickname: parsed.data.nickname.trim(),
        accountNumber: parsed.data.accountNumber.trim(),
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "PAYEE_SAVED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "SavedPayee",
      targetId: payee.id,
      metadata: { nickname: payee.nickname },
    });

    res.status(201).json({ payee });
  })
);

router.delete(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const payee = await prisma.savedPayee.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!payee) {
      throw new NotFoundError("Saved payee not found");
    }
    await prisma.savedPayee.delete({ where: { id: payee.id } });
    res.status(204).end();
  })
);

export default router;
