import { findAccountByNumber } from "./accounts.repository";

export async function generateUniqueAccountNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `US-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await findAccountByNumber(candidate);
    if (!existing) return candidate;
  }
  throw new Error("Could not generate a unique account number");
}
