// One-off helper: renames every user email from the old @hoanglambank.dev
// domain to @lambank.dev on your existing database (the seed script only
// creates new accounts when the email doesn't exist yet, so it can't rename
// accounts that were already created under the old domain).
//
// If re-running the seed script after the domain changed created duplicate
// companies (same person, same role, but a fresh empty company under the new
// domain), this script detects that, deletes the newer/duplicate company
// entirely, and keeps the older/established one — then renames it.
//
// Run from the backend folder:
//   npx tsx scripts/rename-email-domain.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OLD_DOMAIN = "@hoanglambank.dev";
const NEW_DOMAIN = "@lambank.dev";

async function describe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: { select: { id: true, name: true, createdAt: true } } },
  });
  if (!user || !user.company) return null;
  return { user, company: user.company };
}

// Deletes a company and every row that references it, in an order that
// respects the schema's foreign keys. Only tables with an enforced FK
// relation need careful ordering; the rest (CreditApply, Drawdown,
// Repayment, RecurringTransfer, SavedPayee, MerchantCategory,
// ApprovalRequest) are plain companyId columns with no DB-level constraint,
// so they're cleaned up too but order doesn't matter for those.
async function deleteCompanyCascade(companyId: string) {
  const accountIds = (await prisma.account.findMany({ where: { companyId }, select: { id: true } })).map((a) => a.id);
  const userIds = (await prisma.user.findMany({ where: { companyId }, select: { id: true } })).map((u) => u.id);

  if (accountIds.length > 0) {
    await prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } });
  }
  await prisma.card.deleteMany({ where: { companyId } });
  await prisma.budget.deleteMany({ where: { companyId } });
  await prisma.claim.deleteMany({ where: { companyId } });
  await prisma.receipt.deleteMany({ where: { companyId } });
  await prisma.bill.deleteMany({ where: { companyId } });
  await prisma.spendPolicy.deleteMany({ where: { companyId } });
  await prisma.beneficialOwner.deleteMany({ where: { companyId } });
  await prisma.kybDocument.deleteMany({ where: { companyId } });
  await prisma.businessProfile.deleteMany({ where: { companyId } });
  await prisma.account.deleteMany({ where: { companyId } });
  await prisma.creditApply.deleteMany({ where: { companyId } });
  await prisma.drawdown.deleteMany({ where: { companyId } });
  await prisma.repayment.deleteMany({ where: { companyId } });
  await prisma.recurringTransfer.deleteMany({ where: { companyId } });
  await prisma.savedPayee.deleteMany({ where: { companyId } });
  await prisma.merchantCategory.deleteMany({ where: { companyId } });
  await prisma.approvalRequest.deleteMany({ where: { companyId } });
  if (userIds.length > 0) {
    await prisma.kycProfile.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
}

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: OLD_DOMAIN } },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    console.log(`No users found with an ${OLD_DOMAIN} email — nothing to rename.`);
    return;
  }

  let renamed = 0;
  let skipped = 0;
  let cleanedUp = 0;

  for (const user of users) {
    // Re-check each user still exists — an earlier iteration in this same
    // loop may have already deleted this user's whole company as someone
    // else's duplicate (e.g. two staff accounts sharing one company).
    const stillExists = await prisma.user.findUnique({ where: { id: user.id } });
    if (!stillExists) continue;

    const newEmail = user.email.replace(OLD_DOMAIN, NEW_DOMAIN);
    const conflictUser = await prisma.user.findUnique({ where: { email: newEmail } });

    if (!conflictUser) {
      await prisma.user.update({ where: { id: user.id }, data: { email: newEmail } });
      console.log(`${user.email} -> ${newEmail}`);
      renamed++;
      continue;
    }

    const oldSide = await describe(user.id);
    const newSide = await describe(conflictUser.id);
    if (!oldSide || !newSide) {
      skipped++;
      console.log(`\nSKIPPED — couldn't load company info for ${user.email} / ${newEmail}.`);
      continue;
    }

    // Keep whichever company was created first (the established, real one);
    // delete the other outright.
    const oldIsEstablished = oldSide.company.createdAt.getTime() <= newSide.company.createdAt.getTime();
    const keep = oldIsEstablished ? oldSide : newSide;
    const remove = oldIsEstablished ? newSide : oldSide;

    console.log(`\nCONFLICT on ${newEmail}:`);
    console.log(`  keeping   "${keep.company.name}" [${keep.company.id}], created ${keep.company.createdAt.toISOString()}`);
    console.log(`  deleting  "${remove.company.name}" [${remove.company.id}], created ${remove.company.createdAt.toISOString()}`);

    await deleteCompanyCascade(remove.company.id);
    cleanedUp++;

    if (oldIsEstablished) {
      await prisma.user.update({ where: { id: user.id }, data: { email: newEmail } });
      console.log(`  ${user.email} -> ${newEmail}`);
      renamed++;
    } else {
      console.log(`  ${newEmail} already correct on the kept company — nothing more to do.`);
    }
  }

  console.log(`\nRenamed ${renamed} account(s), removed ${cleanedUp} duplicate compan${cleanedUp === 1 ? "y" : "ies"}, skipped ${skipped}.`);
  if (renamed > 0) {
    console.log("Log back in with the new @lambank.dev email for any account that was renamed.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
