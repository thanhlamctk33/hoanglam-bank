// One-off script: renames the already-seeded "Demo Trading Co." company
// (seed.ts is idempotent and won't touch it once demo@lambank.dev exists).
// Run once with: npx tsx prisma/rename-demo-company.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const NEW_NAME = "Hoang Lam Import-Export Trading Joint Stock Company";

async function main() {
  const result = await prisma.company.updateMany({
    where: { name: "Demo Trading Co." },
    data: { name: NEW_NAME },
  });
  if (result.count > 0) {
    console.log(`Renamed ${result.count} company record(s) to "${NEW_NAME}".`);
  } else {
    console.log('No company named "Demo Trading Co." found — nothing to rename.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
