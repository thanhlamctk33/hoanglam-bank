import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import * as cardsService from "./cards.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const cards = await cardsService.listCards(req.companyId);
    res.json({ cards });
  })
);

router.get(
  "/assignable-users",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const users = await cardsService.listAssignableUsers(req.companyId);
    res.json({ users });
  })
);

const createSchema = z.object({
  label: z.string().min(1),
  type: z.enum(["VIRTUAL", "PHYSICAL", "PREPAID"]),
  currency: z.string().default("USD"),
  spendLimit: z.number().positive(),
  ownerId: z.string().uuid().optional(),
  budgetId: z.string().uuid().optional(),
  // Required for PREPAID — the Cash Account the preload amount is drawn
  // from, and that every subsequent purchase on this card debits.
  accountId: z.string().uuid().optional(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await cardsService.createCard(req.companyId, req.userId, parsed.data);
    res.status(201).json({ card });
  })
);

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "FROZEN", "CANCELLED"]),
  password: z.string().min(1),
});

router.patch(
  "/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await cardsService.setCardStatus(req.companyId, req.params.id, parsed.data.status, parsed.data.password, req.userId);
    res.json({ card });
  })
);

const resubmitSchema = z.object({
  label: z.string().min(1),
  spendLimit: z.number().positive(),
});

router.patch(
  "/:id/resubmit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = resubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await cardsService.resubmitCard(req.companyId, req.params.id, parsed.data);
    res.json({ card });
  })
);

const revealSchema = z.object({
  password: z.string().min(1),
});

router.post(
  "/:id/reveal",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = revealSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const revealed = await cardsService.revealCard(req.companyId, req.params.id, parsed.data.password, req.userId);
    res.json(revealed);
  })
);

// Testing only — a hard delete, unlike PATCH /:id/status → CANCELLED which
// just marks a card unusable while keeping its history. Admin-only; also
// clears out any dangling approval request left behind if the card was
// still PENDING.
router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await cardsService.deleteCard(req.companyId, req.params.id, req.userId);
    res.status(204).end();
  })
);

const controlsSchema = z.object({
  allowOnline: z.boolean(),
  allowAtm: z.boolean(),
  blockedCategories: z.array(z.string().min(1).max(40)).max(20),
});

router.patch(
  "/:id/controls",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = controlsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await cardsService.updateCardControls(req.companyId, req.params.id, parsed.data, req.userId);
    res.json({ card });
  })
);

const simulatePurchaseSchema = z.object({
  amount: z.number().positive(),
  merchantCategory: z.string().max(40).optional(),
  channel: z.enum(["ONLINE", "IN_STORE", "ATM"]),
});

router.post(
  "/:id/simulate-purchase",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = simulatePurchaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await cardsService.simulatePurchase(req.companyId, req.params.id, parsed.data, req.userId);
    res.json({ card });
  })
);

export default router;
