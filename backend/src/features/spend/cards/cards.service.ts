import bcrypt from "bcryptjs";
import {
  BadRequestError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
  UnprocessableEntityError,
} from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { createApprovalRequest } from "../../compliance/approvals/approval.service";
import { checkLimit } from "../../platform/subscription/subscription.service";
import { checkPhysicalCardAllowed } from "../../compliance/kyb/kyb.service";
import { hasApprovalPower } from "../../../middleware/companyAdmin";
import { convertCurrency } from "../../../shared/fx/fx.service";
import * as cardsRepo from "./cards.repository";

/**
 * Business logic for cards — every route in cards.routes.ts is a thin
 * validate-then-call-this wrapper. All Prisma access goes through
 * cards.repository.ts.
 */

function generateCardNumber(type: "VIRTUAL" | "PHYSICAL" | "PREPAID") {
  const prefix = type === "VIRTUAL" ? "4" : type === "PHYSICAL" ? "5" : "6";
  let digits = prefix;
  for (let digitIndex = 0; digitIndex < 15; digitIndex++) digits += Math.floor(Math.random() * 10);
  return digits;
}

function generateExpiry() {
  const now = new Date();
  return { expMonth: now.getMonth() + 1, expYear: now.getFullYear() + 5 };
}

function generateCvv() {
  return String(Math.floor(100 + Math.random() * 900));
}

async function verifyPassword(userId: string | undefined, password: string) {
  if (!userId) return false;
  const user = await cardsRepo.findUserById(userId);
  if (!user) return false;
  return bcrypt.compare(password, user.passwordHash);
}

export function listCards(companyId: string) {
  return cardsRepo.findCardsByCompany(companyId);
}

export function listAssignableUsers(companyId: string) {
  return cardsRepo.findAssignableUsers(companyId);
}

export interface CreateCardParams {
  label: string;
  type: "VIRTUAL" | "PHYSICAL" | "PREPAID";
  currency: string;
  spendLimit: number;
  ownerId?: string;
  budgetId?: string;
  accountId?: string;
}

export async function createCard(companyId: string, userId: string, params: CreateCardParams) {
  const { label, type, spendLimit, ownerId, budgetId, accountId } = params;
  let { currency } = params;

  const limitCheck = await checkLimit(companyId, "card");
  if (!limitCheck.allowed) {
    throw new PaymentRequiredError(limitCheck.message);
  }

  if (type === "PHYSICAL") {
    const kybCheck = await checkPhysicalCardAllowed(companyId);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }
  }

  let fundingAccount = null;
  if (type === "PREPAID") {
    if (!accountId) {
      throw new BadRequestError("Pick a Cash Account to fund this prepaid card from.");
    }
    fundingAccount = await cardsRepo.findOwnAccount(companyId, accountId);
    if (!fundingAccount) {
      throw new BadRequestError("Account not found in this company");
    }
    if (fundingAccount.frozen) {
      throw new UnprocessableEntityError("This account is frozen and can't fund a prepaid card.");
    }
    // A prepaid card's purchases debit its linked account directly, in that
    // account's own currency — no FX conversion at spend time.
    currency = fundingAccount.currency;
  }

  if (ownerId) {
    const owner = await cardsRepo.findOwnUser(companyId, ownerId);
    if (!owner) {
      throw new BadRequestError("Owner not found in this company");
    }
  }

  let budget = null;
  if (budgetId && type !== "PREPAID") {
    budget = await cardsRepo.findOwnBudget(companyId, budgetId);
    if (!budget) {
      throw new BadRequestError("Budget not found in this company");
    }
    if (budget.status === "FROZEN") {
      throw new UnprocessableEntityError(`"${budget.name}" is frozen — unfreeze it before assigning cards.`);
    }

    const existingCards = await cardsRepo.findActiveCardSpendLimits(budgetId);
    const alreadyAssigned = existingCards.reduce((sum, card) => sum + Number(card.spendLimit), 0);
    if (alreadyAssigned + spendLimit > Number(budget.amount)) {
      throw new UnprocessableEntityError(
        `This card's spend limit would push "${budget.name}" to ${(alreadyAssigned + spendLimit).toFixed(
          2
        )}, above its ${Number(budget.amount).toFixed(2)} budget.`
      );
    }
  }

  // Spend policy (Spend > Policies): a hard cap blocks the card outright;
  // the approval threshold forces this into the approval queue even for a
  // requester who'd normally skip it (Admin/staff). Policy caps are always
  // set in USD, so the card's limit is converted to USD before comparing.
  const policy = await cardsRepo.findSpendPolicy(companyId);
  const spendLimitInUsd = convertCurrency(spendLimit, currency, "USD");
  if (policy?.cardSpendLimitCap && spendLimitInUsd > Number(policy.cardSpendLimitCap)) {
    throw new UnprocessableEntityError(
      `Exceeds your company's spend policy — cards can't be issued with a limit above ${Number(
        policy.cardSpendLimitCap
      ).toFixed(2)} USD.`
    );
  }

  const policyForcesApproval = !!policy?.approvalThreshold && spendLimitInUsd >= Number(policy.approvalThreshold);
  const actor = await cardsRepo.findUserById(userId);
  const needsApproval = !hasApprovalPower(actor) || policyForcesApproval;

  const cardNumber = generateCardNumber(type);
  const { expMonth, expYear } = generateExpiry();

  const card = await cardsRepo.createCard({
    label,
    type,
    currency,
    spendLimit,
    cardNumber,
    last4: cardNumber.slice(-4),
    cvv: generateCvv(),
    expMonth,
    expYear,
    status: needsApproval ? "PENDING" : "ACTIVE",
    companyId,
    ownerId,
    budgetId: type === "PREPAID" ? undefined : budgetId,
    accountId: type === "PREPAID" ? fundingAccount!.id : undefined,
  });

  if (needsApproval) {
    await createApprovalRequest({
      targetType: "CARD",
      targetId: card.id,
      companyId,
      requesterId: userId,
      metadata: { label: card.label, type: card.type, spendLimit: spendLimit.toString(), budget: budget?.name ?? "None" },
    });
  }

  await writeAuditLog({
    action: needsApproval ? "CARD_REQUESTED" : "CARD_ISSUED",
    actorEmail: actor?.email ?? "unknown",
    targetType: "Card",
    targetId: card.id,
    metadata: { label: card.label, type: card.type, budget: budget?.name ?? "None" },
  });

  return card;
}

export async function setCardStatus(
  companyId: string,
  cardId: string,
  status: "ACTIVE" | "FROZEN" | "CANCELLED",
  password: string,
  userId: string
) {
  if (!(await verifyPassword(userId, password))) {
    throw new UnauthorizedError("Incorrect password");
  }

  const card = await cardsRepo.findOwnCard(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }
  if (card.status !== "ACTIVE" && card.status !== "FROZEN") {
    throw new UnprocessableEntityError("This card is not active yet");
  }

  return cardsRepo.updateCardStatus(card.id, status);
}

export interface ResubmitCardParams {
  label: string;
  spendLimit: number;
}

export async function resubmitCard(companyId: string, cardId: string, params: ResubmitCardParams) {
  const card = await cardsRepo.findOwnCard(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }
  if (card.status !== "REJECTED") {
    throw new UnprocessableEntityError("Only rejected requests can be resubmitted");
  }

  if (card.budgetId) {
    const budget = await cardsRepo.findBudgetById(card.budgetId);
    if (budget) {
      const existingCards = await cardsRepo.findActiveCardSpendLimits(card.budgetId, card.id);
      const alreadyAssigned = existingCards.reduce((sum, card) => sum + Number(card.spendLimit), 0);
      if (alreadyAssigned + params.spendLimit > Number(budget.amount)) {
        throw new UnprocessableEntityError(
          `This card's spend limit would push "${budget.name}" to ${(alreadyAssigned + params.spendLimit).toFixed(
            2
          )}, above its ${Number(budget.amount).toFixed(2)} budget.`
        );
      }
    }
  }

  const updated = await cardsRepo.updateCardResubmit(card.id, params);

  const request = await cardsRepo.findLatestApprovalRequestForCard(card.id);
  if (request) {
    await cardsRepo.resetApprovalRequestForResubmit(
      request.id,
      JSON.stringify({ label: params.label, type: card.type, spendLimit: params.spendLimit.toString() })
    );
  }

  return updated;
}

export async function revealCard(companyId: string, cardId: string, password: string, userId: string) {
  if (!(await verifyPassword(userId, password))) {
    throw new UnauthorizedError("Incorrect password");
  }

  const card = await cardsRepo.findCardRevealFields(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }

  return { cardNumber: card.cardNumber, cvv: card.cvv };
}

// Testing only — a hard delete, unlike PATCH /:id/status → CANCELLED which
// just marks a card unusable while keeping its history. Admin-only; also
// clears out any dangling approval request left behind if the card was
// still PENDING.
export async function deleteCard(companyId: string, cardId: string, userId: string) {
  const card = await cardsRepo.findOwnCard(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }

  await cardsRepo.deleteCard(card.id);
  await cardsRepo.deleteApprovalRequestsForCard(card.id);

  await writeAuditLog({
    action: "CARD_DELETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Card",
    targetId: card.id,
    metadata: { label: card.label, type: card.type },
  });
}

export interface UpdateCardControlsParams {
  allowOnline: boolean;
  allowAtm: boolean;
  blockedCategories: string[];
}

export async function updateCardControls(companyId: string, cardId: string, params: UpdateCardControlsParams, userId: string) {
  const card = await cardsRepo.findOwnCard(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }

  const updated = await cardsRepo.updateCardControls(card.id, params);

  await writeAuditLog({
    action: "CARD_CONTROLS_UPDATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Card",
    targetId: card.id,
    metadata: {
      allowOnline: String(params.allowOnline),
      allowAtm: String(params.allowAtm),
      blockedCategories: params.blockedCategories.join(", "),
    },
  });

  return updated;
}

// This app has no real card network — nothing else ever moves money against
// a card's spend limit. This endpoint exists so allowOnline/allowAtm/
// blockedCategories are real, testable rules rather than settings that do
// nothing. For VIRTUAL/PHYSICAL cards it only touches the card's (and its
// budget's, if assigned) `spent` counters, not an Account balance — those
// were never linked to a specific settlement account, spend limits are
// tracked independently. PREPAID cards are the exception: they're linked to
// a real Account via `accountId`, so a purchase actually debits it too.
export interface SimulatePurchaseParams {
  amount: number;
  merchantCategory?: string;
  channel: "ONLINE" | "IN_STORE" | "ATM";
}

export async function simulatePurchase(companyId: string, cardId: string, params: SimulatePurchaseParams, userId: string) {
  const { amount, merchantCategory, channel } = params;

  const card = await cardsRepo.findOwnCard(companyId, cardId);
  if (!card) {
    throw new NotFoundError("Card not found");
  }
  if (card.status !== "ACTIVE") {
    throw new UnprocessableEntityError(`This card is ${card.status.toLowerCase()} and can't be used.`);
  }
  if (channel === "ONLINE" && !card.allowOnline) {
    throw new ForbiddenError("Online purchases are turned off for this card.");
  }
  if (channel === "ATM" && !card.allowAtm) {
    throw new ForbiddenError("ATM withdrawals are turned off for this card.");
  }

  const blocked: string[] = card.blockedCategories ? JSON.parse(card.blockedCategories) : [];
  if (merchantCategory && blocked.includes(merchantCategory)) {
    throw new ForbiddenError(`Purchases in "${merchantCategory}" are blocked for this card.`);
  }

  const newSpent = Number(card.spent) + amount;
  if (newSpent > Number(card.spendLimit)) {
    throw new UnprocessableEntityError(
      `This purchase would push spend to ${newSpent.toFixed(2)}, above the ${Number(card.spendLimit).toFixed(2)} ${
        card.type === "PREPAID" ? "loaded balance" : "monthly limit"
      }.`
    );
  }

  // PREPAID cards debit their linked Account for real, on top of the usual
  // spendLimit/spent bookkeeping — that's what makes them "real money"
  // rather than an internal-only cap like VIRTUAL/PHYSICAL cards.
  let fundingAccount = null;
  if (card.type === "PREPAID") {
    if (!card.accountId) {
      throw new UnprocessableEntityError("This prepaid card isn't linked to a Cash Account.");
    }
    fundingAccount = await cardsRepo.findOwnAccount(companyId, card.accountId);
    if (!fundingAccount) {
      throw new UnprocessableEntityError("The Cash Account backing this card no longer exists.");
    }
    if (fundingAccount.frozen) {
      throw new LockedError("The Cash Account backing this card is frozen.");
    }
    if (Number(fundingAccount.balance) < amount) {
      throw new UnprocessableEntityError("Insufficient balance in the linked Cash Account.");
    }
  }

  const writeOperations = [
    cardsRepo.incrementCardSpent(card.id, amount),
    ...(fundingAccount
      ? [
          cardsRepo.decrementAccountBalance(fundingAccount.id, amount),
          cardsRepo.createCardPurchaseTransaction({
            accountId: fundingAccount.id,
            amount,
            currency: fundingAccount.currency,
            type: "DEBIT" as const,
            description: `${card.label} •••• ${card.last4}`,
            category: "Card purchase",
            merchantCategory: merchantCategory ?? null,
          }),
        ]
      : []),
  ];
  const [updated] = (await cardsRepo.runBatchedWrites(writeOperations)) as [Awaited<ReturnType<typeof cardsRepo.incrementCardSpent>>];

  if (card.budgetId) {
    await cardsRepo.incrementBudgetSpent(card.budgetId, amount).catch(() => {});
  }

  await writeAuditLog({
    action: "CARD_PURCHASE_SIMULATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Card",
    targetId: card.id,
    metadata: { amount: amount.toString(), channel, merchantCategory: merchantCategory ?? "" },
  });

  return updated;
}
