import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function randomAmount(min: number, max: number) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

async function seedStaff() {
  const staffEmail = "admin@lambank.dev";
  const existing = await prisma.user.findUnique({ where: { email: staffEmail } });
  if (!existing) {
    const passwordHash = await bcrypt.hash("staff123", 10);
    await prisma.company.create({
      data: {
        name: "LamBank Staff",
        users: {
          create: {
            name: "Ngan Ha",
            email: staffEmail,
            passwordHash,
            role: "ADMIN",
            isStaff: true,
          },
        },
      },
    });
    console.log(`Staff login: ${staffEmail} / password: staff123`);
  }

  // A second staff account so maker-checker on Credit Apply is actually
  // testable (a checker must be a different staff member than the maker).
  const checkerEmail = "checker@lambank.dev";
  const existingChecker = await prisma.user.findUnique({ where: { email: checkerEmail } });
  if (!existingChecker) {
    const passwordHash = await bcrypt.hash("staff123", 10);
    const staffCompany = await prisma.company.findFirst({ where: { name: "LamBank Staff" } });
    if (staffCompany) {
      await prisma.user.create({
        data: {
          name: "Minh Duc",
          email: checkerEmail,
          passwordHash,
          role: "ADMIN",
          isStaff: true,
          companyId: staffCompany.id,
        },
      });
      console.log(`Staff (checker) login: ${checkerEmail} / password: staff123`);
    }
  }
}

async function seedSecondCustomer() {
  const email = "hoa@lambank.dev";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;

  const passwordHash = await bcrypt.hash("password123", 10);
  const company = await prisma.company.create({
    data: {
      name: "Nguyen Minh Trading",
      users: {
        create: {
          name: "Nguyen Thi Hoa",
          email,
          passwordHash,
          role: "ADMIN",
        },
      },
    },
  });
  await prisma.account.create({
    data: {
      name: "Cash Account",
      currency: "USD",
      balance: 45200,
      accountNumber: "US-0002-7734",
      companyId: company.id,
    },
  });
  console.log(`Second customer login: ${email} / password: password123 (account US-0002-7734)`);
}

async function seedDemoMember(companyId: string) {
  const memberEmail = "member@lambank.dev";
  const existing = await prisma.user.findUnique({ where: { email: memberEmail } });
  if (existing) return;

  await prisma.user.create({
    data: {
      name: "Minh Tran",
      email: memberEmail,
      passwordHash: await bcrypt.hash("password123", 10),
      role: "MEMBER",
      companyId,
    },
  });
  console.log(`Team member login: ${memberEmail} / password: password123 (role MEMBER, requests need Thanh Lam's approval)`);
}

/**
 * Walks "Hoang Lam Import-Export Trading Joint Stock Company" through the full lending journey (KYB approved,
 * contract signed, Credit Apply approved via maker-checker, one drawdown,
 * one repayment) so the /credit page and the dashboard's Credit
 * Applications queue both have real data to show out of the box.
 */
async function seedCreditDemo(companyId: string, directorUserId: string, cashAccountId: string) {
  const existing = await prisma.creditApply.findFirst({ where: { companyId } });
  if (existing) return;

  const maker = await prisma.user.findUnique({ where: { email: "admin@lambank.dev" } });
  const checker = await prisma.user.findUnique({ where: { email: "checker@lambank.dev" } });
  if (!maker || !checker) return;

  await prisma.company.update({
    where: { id: companyId },
    data: { kybStatus: "APPROVED", kybReviewedAt: new Date(), contractAcceptedAt: new Date() },
  });

  const createdAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 20);
  const decidedAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 19);
  const drawdownAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 15);
  const repaymentAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3);

  const creditApply = await prisma.creditApply.create({
    data: {
      companyId,
      requestedAmount: 50000,
      approvedAmount: 50000,
      drawnAmount: 15000,
      status: "APPROVED",
      makerId: maker.id,
      checkerId: checker.id,
      makerNote: "Established trading company, 8 months of clean transaction history.",
      checkerNote: "Approved at requested amount.",
      createdAt,
      decidedAt,
    },
  });

  await prisma.drawdown.create({
    data: {
      companyId,
      creditApplyId: creditApply.id,
      accountId: cashAccountId,
      requestedById: directorUserId,
      amount: 20000,
      interestRatePct: 12,
      termMonths: 12,
      createdAt: drawdownAt,
    },
  });
  await prisma.repayment.create({
    data: {
      companyId,
      creditApplyId: creditApply.id,
      accountId: cashAccountId,
      requestedById: directorUserId,
      amount: 5000,
      createdAt: repaymentAt,
    },
  });

  await prisma.transaction.createMany({
    data: [
      {
        accountId: cashAccountId,
        amount: 20000,
        currency: "USD",
        type: "CREDIT",
        description: "Drawdown from credit line (12% APR, 12mo)",
        category: "Drawdown",
        date: drawdownAt,
      },
      {
        accountId: cashAccountId,
        amount: 5000,
        currency: "USD",
        type: "DEBIT",
        description: "Repayment towards credit line",
        category: "Repayment",
        date: repaymentAt,
      },
    ],
  });

  // Net cash effect of the drawdown/repayment above (+20,000 -5,000).
  await prisma.account.update({
    where: { id: cashAccountId },
    data: { balance: { increment: 15000 } },
  });

  console.log("Seeded a $50,000 approved credit line for Hoang Lam Import-Export Trading Joint Stock Company (drawn $20,000, repaid $5,000).");
}

// Backfills an APPROVED KycProfile for a demo user so the new mandatory
// onboarding gate (register → KYC → KYB → main dashboard) doesn't strand
// existing demo logins in the wizard. Deliberately NOT called for the
// "second customer" (hoa@lambank.dev) — that account's company is
// intentionally left un-verified so it doubles as a live demo of the
// onboarding flow.
async function seedApprovedKyc(userId: string, fullName: string) {
  const existing = await prisma.kycProfile.findUnique({ where: { userId } });
  if (existing) return;
  const now = new Date();
  await prisma.kycProfile.create({
    data: {
      userId,
      fullName,
      dateOfBirth: new Date("1990-01-01"),
      nationality: "Vietnam",
      idType: "NATIONAL_ID",
      idNumber: "079090001234",
      idDocumentUrl: "data:image/png;base64,demo-seed-placeholder",
      status: "APPROVED",
      submittedAt: now,
      reviewedAt: now,
    },
  });
}

const DEFAULT_MERCHANT_CATEGORIES = ["Travel", "Entertainment", "Software", "Office supplies", "Dining", "Advertising"];

// Backfills the merchant-category list Settings → Categories manages —
// additive/idempotent (skipDuplicates), safe to re-run on an existing DB.
async function seedMerchantCategories(companyId: string) {
  await prisma.merchantCategory.createMany({
    data: DEFAULT_MERCHANT_CATEGORIES.map((name) => ({ companyId, name })),
    skipDuplicates: true,
  });
}

async function main() {
  await seedStaff();
  await seedSecondCustomer();

  const email = "demo@lambank.dev";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Primary demo customer already seeded, skipping.");
    await seedDemoMember(existing.companyId);
    await seedMerchantCategories(existing.companyId);
    await seedApprovedKyc(existing.id, existing.name);
    const cashAccount = await prisma.account.findFirst({ where: { companyId: existing.companyId } });
    if (cashAccount) {
      await seedCreditDemo(existing.companyId, existing.id, cashAccount.id);
    }
    return;
  }

  const passwordHash = await bcrypt.hash("password123", 10);

  const company = await prisma.company.create({
    data: {
      name: "Hoang Lam Import-Export Trading Joint Stock Company",
      users: {
        create: {
          name: "Thanh Lam",
          email,
          passwordHash,
          role: "ADMIN",
        },
      },
    },
    include: { users: true },
  });
  const user = company.users[0];

  await seedDemoMember(company.id);
  await seedMerchantCategories(company.id);
  await seedApprovedKyc(user.id, user.name);

  const cashAccount = await prisma.account.create({
    data: {
      name: "Cash Account",
      currency: "USD",
      balance: 128450.32,
      accountNumber: "US-0001-4821",
      companyId: company.id,
    },
  });

  const merchants = [
    { desc: "AWS Cloud Services", category: "Software", type: "DEBIT" as const },
    { desc: "Client Payment - Acme Corp", category: "Revenue", type: "CREDIT" as const },
    { desc: "Google Workspace", category: "Software", type: "DEBIT" as const },
    { desc: "Office Rent", category: "Facilities", type: "DEBIT" as const },
    { desc: "Client Payment - Globex", category: "Revenue", type: "CREDIT" as const },
    { desc: "Payroll Run", category: "Payroll", type: "DEBIT" as const },
    { desc: "Facebook Ads", category: "Marketing", type: "DEBIT" as const },
    { desc: "Client Payment - Initech", category: "Revenue", type: "CREDIT" as const },
  ];

  await prisma.transaction.createMany({
    data: merchants.map((m, i) => ({
      accountId: cashAccount.id,
      amount: m.type === "DEBIT" ? randomAmount(50, 5000) : randomAmount(1000, 20000),
      currency: "USD",
      type: m.type,
      description: m.desc,
      category: m.category,
      merchant: m.desc,
      date: new Date(Date.now() - i * 1000 * 60 * 60 * 24 * 2),
    })),
  });

  await prisma.card.createMany({
    data: [
      {
        label: "Marketing Team Card",
        cardNumber: "4532015112834821",
        last4: "4821",
        cvv: "482",
        expMonth: 9,
        expYear: 2029,
        type: "VIRTUAL",
        status: "ACTIVE",
        currency: "USD",
        spendLimit: 5000,
        spent: 1820.5,
        companyId: company.id,
        ownerId: user.id,
      },
      {
        label: "Ops Physical Card",
        cardNumber: "5412750098231190",
        last4: "1190",
        cvv: "719",
        expMonth: 3,
        expYear: 2028,
        type: "PHYSICAL",
        status: "ACTIVE",
        currency: "USD",
        spendLimit: 3000,
        spent: 640,
        companyId: company.id,
        ownerId: user.id,
      },
      {
        label: "Travel Card",
        cardNumber: "4916738245017734",
        last4: "7734",
        cvv: "356",
        expMonth: 12,
        expYear: 2027,
        type: "VIRTUAL",
        status: "FROZEN",
        currency: "USD",
        spendLimit: 2000,
        spent: 0,
        companyId: company.id,
      },
    ],
  });

  await prisma.budget.createMany({
    data: [
      {
        name: "Marketing Q3",
        amount: 10000,
        spent: 6420.15,
        currency: "USD",
        period: "QUARTERLY",
        companyId: company.id,
        ownerId: user.id,
      },
      {
        name: "Engineering Tools",
        amount: 4000,
        spent: 3120,
        currency: "USD",
        period: "MONTHLY",
        companyId: company.id,
        ownerId: user.id,
      },
    ],
  });

  await prisma.claim.createMany({
    data: [
      {
        title: "Client dinner - Acme Corp",
        amount: 182.4,
        currency: "USD",
        status: "PENDING",
        description: "Dinner with Acme Corp procurement team",
        companyId: company.id,
        submittedById: user.id,
      },
      {
        title: "Flight to Singapore",
        amount: 890,
        currency: "USD",
        status: "APPROVED",
        description: "Client site visit",
        companyId: company.id,
        submittedById: user.id,
      },
    ],
  });

  await prisma.bill.createMany({
    data: [
      {
        vendor: "WeWork",
        amount: 2400,
        currency: "USD",
        status: "UNPAID",
        dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
        companyId: company.id,
      },
      {
        vendor: "Zoom",
        amount: 149,
        currency: "USD",
        status: "PAID",
        dueDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5),
        companyId: company.id,
      },
      {
        vendor: "Adobe Creative Cloud",
        amount: 599,
        currency: "USD",
        status: "OVERDUE",
        dueDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
        companyId: company.id,
      },
    ],
  });

  await seedCreditDemo(company.id, user.id, cashAccount.id);

  console.log("Seed complete.");
  console.log(`Login with email: ${email} / password: password123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
