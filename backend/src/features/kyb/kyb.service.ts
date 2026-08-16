import { NotFoundError, UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { KybDocumentType, KybStatus, UNVERIFIED_TRANSACTION_LIMIT } from "./kyb.config";
import * as kybRepo from "./kyb.repository";
import { findCompanyKybStatus } from "./kyb.repository";

export async function getKybStatus(companyId: string): Promise<KybStatus> {
  const company = await findCompanyKybStatus(companyId);
  return (company?.kybStatus as KybStatus) ?? "NOT_STARTED";
}

/**
 * Checks whether a money-movement of `amount` is allowed for a company that
 * hasn't completed business verification yet. Approved companies have no cap.
 */
export async function checkTransactionAllowed(
  companyId: string,
  amount: number
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  if (amount <= UNVERIFIED_TRANSACTION_LIMIT) return { allowed: true };

  const status = await getKybStatus(companyId);
  if (status === "APPROVED") return { allowed: true };

  return {
    allowed: false,
    message: `Payments over $${UNVERIFIED_TRANSACTION_LIMIT.toLocaleString()} require completed business verification. Finish it under Settings → Business verification.`,
  };
}

export async function checkPhysicalCardAllowed(
  companyId: string
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const status = await getKybStatus(companyId);
  if (status === "APPROVED") return { allowed: true };
  return {
    allowed: false,
    message: "Physical cards require completed business verification. Finish it under Settings → Business verification.",
  };
}

// ---------------------------------------------------------------------------
// Customer-facing verification wizard — kyb.routes.ts is a thin
// validate-then-call wrapper over everything below.
// ---------------------------------------------------------------------------

/** The whole wizard state in one shot: status plus profile, owners and documents. */
export async function loadKybState(companyId: string) {
  const [company, businessProfile, beneficialOwners, kybDocuments] = await Promise.all([
    kybRepo.findCompanyKybState(companyId),
    kybRepo.findBusinessProfile(companyId),
    kybRepo.findBeneficialOwners(companyId),
    kybRepo.findKybDocuments(companyId),
  ]);
  return {
    status: (company?.kybStatus as KybStatus) ?? "NOT_STARTED",
    submittedAt: company?.kybSubmittedAt ?? null,
    reviewedAt: company?.kybReviewedAt ?? null,
    rejectionReason: company?.kybRejectionReason ?? null,
    businessProfile,
    beneficialOwners,
    kybDocuments,
  };
}

/**
 * Blocks edits once a submission is locked in — under review or already
 * approved. Throws so every mutating route gets the same guard without
 * repeating the message.
 */
async function assertEditable(companyId: string) {
  const status = await getKybStatus(companyId);
  if (status === "PENDING_REVIEW") {
    throw new UnprocessableEntityError(
      "Your verification is currently under review — you can't make changes until it's reviewed."
    );
  }
  if (status === "APPROVED") {
    throw new UnprocessableEntityError("Your business is already verified.");
  }
}

export interface BusinessProfileParams {
  legalName: string;
  registrationNumber: string;
  taxCode: string;
  incorporationDate: Date;
  businessType: string;
  industry: string;
  registeredAddress: string;
  website?: string;
  expectedMonthlyVolume: number;
}

export async function saveBusinessProfile(companyId: string, params: BusinessProfileParams) {
  await assertEditable(companyId);

  const { website, ...rest } = params;
  return kybRepo.upsertBusinessProfile(companyId, { ...rest, website: website || null });
}

export interface BeneficialOwnerParams {
  fullName: string;
  dateOfBirth: Date;
  nationality: string;
  ownershipPct: number;
  role: string;
  idNumber: string;
}

export async function addBeneficialOwner(companyId: string, params: BeneficialOwnerParams) {
  await assertEditable(companyId);
  return kybRepo.createBeneficialOwner({ ...params, companyId });
}

export async function removeBeneficialOwner(companyId: string, id: string) {
  const owner = await kybRepo.findOwnBeneficialOwner(companyId, id);
  if (!owner) {
    throw new NotFoundError("Owner not found");
  }
  await assertEditable(companyId);
  await kybRepo.deleteBeneficialOwner(owner.id);
}

export interface KybDocumentParams {
  type: KybDocumentType;
  filename: string;
  mimeType: string;
  fileBase64: string;
}

export async function addKybDocument(companyId: string, params: KybDocumentParams) {
  await assertEditable(companyId);

  const { fileBase64, mimeType, filename, type } = params;
  return kybRepo.createKybDocument({
    type,
    filename,
    mimeType,
    url: `data:${mimeType};base64,${fileBase64}`,
    companyId,
  });
}

export async function removeKybDocument(companyId: string, id: string) {
  const document = await kybRepo.findOwnKybDocument(companyId, id);
  if (!document) {
    throw new NotFoundError("Document not found");
  }
  await assertEditable(companyId);
  await kybRepo.deleteKybDocument(document.id);
}

export async function submitKyb(companyId: string, userId: string) {
  const state = await loadKybState(companyId);

  if (state.status === "PENDING_REVIEW") {
    throw new UnprocessableEntityError("Your verification is already under review.");
  }
  if (state.status === "APPROVED") {
    // Idempotent: submit may be retried (e.g. the person double-clicked, or
    // an earlier attempt succeeded here but failed on a later step) — treat
    // an already-approved company as success rather than erroring out and
    // permanently stranding them on the review step.
    return state;
  }
  if (!state.businessProfile) {
    throw new UnprocessableEntityError("Complete your business profile before submitting.");
  }
  if (state.beneficialOwners.length === 0) {
    throw new UnprocessableEntityError("Add at least one beneficial owner before submitting.");
  }
  const hasRegistrationDoc = state.kybDocuments.some((d: { type: string }) => d.type === "BUSINESS_REGISTRATION");
  if (!hasRegistrationDoc) {
    throw new UnprocessableEntityError("Upload your business registration document before submitting.");
  }

  const now = new Date();
  // Auto-approved on submit: this is a sandbox with no real underwriting
  // team, and gating the onboarding wizard (register → KYC → KYB → main
  // dashboard) on a human bank-staff review would strand every new signup
  // in PENDING_REVIEW indefinitely. The staff KYB queue at
  // /dashboard/kyb and its approve/reject/needs-info actions still work as
  // before for any company that ends up in PENDING_REVIEW some other way.
  await kybRepo.updateCompanyKyb(companyId, {
    kybStatus: "APPROVED",
    kybSubmittedAt: now,
    kybReviewedAt: now,
    kybRejectionReason: null,
  });

  await writeAuditLog({
    action: "KYB_AUTO_APPROVED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
  });

  return loadKybState(companyId);
}

/**
 * Wipes this company's business profile, beneficial owners, and uploaded
 * documents, and resets kybStatus back to NOT_STARTED, so the verification
 * wizard can be tried again from scratch. Doesn't touch the lending contract
 * or any credit line — those have their own "Complete KYB before you can..."
 * checks, so leaving them as-is just means re-verifying will unblock them
 * again rather than resetting them too.
 */
export async function resetDemoData(companyId: string, userId: string) {
  await kybRepo.deleteKybDocuments(companyId);
  await kybRepo.deleteBeneficialOwners(companyId);
  await kybRepo.deleteBusinessProfile(companyId);
  await kybRepo.updateCompanyKyb(companyId, {
    kybStatus: "NOT_STARTED",
    kybSubmittedAt: null,
    kybReviewedAt: null,
    kybRejectionReason: null,
  });

  await writeAuditLog({
    action: "KYB_DEMO_RESET",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
  });

  return loadKybState(companyId);
}
