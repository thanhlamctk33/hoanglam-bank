import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./auth.repository", () => ({
  incrementTokenVersion: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserWithContextByEmail: vi.fn(),
  findUserWithContextById: vi.fn(),
  findUserTokenVersion: vi.fn(),
  createCompanyWithOwner: vi.fn(),
}));
vi.mock("../../../shared/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
  resolveActorEmail: vi.fn(),
}));
vi.mock("../../lending/credit/credit.service", () => ({ getOrCreatePrimaryAccount: vi.fn() }));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-secret-at-least-16-chars", LOG_LEVEL: "silent", NODE_ENV: "test" },
  isProduction: false,
}));

import { signOutEverywhere } from "./auth.service";
import { verifyToken } from "./jwt.service";
import * as authRepo from "./auth.repository";
import { writeAuditLog } from "../../../shared/audit/audit.service";

const userAfterBump = (tokenVersion: number) => ({
  id: "user-1",
  companyId: "company-1",
  email: "lam@example.com",
  tokenVersion,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signOutEverywhere", () => {
  it("bumps the user's token version so older tokens stop working", async () => {
    vi.mocked(authRepo.incrementTokenVersion).mockResolvedValue(userAfterBump(4) as never);

    await signOutEverywhere("user-1");

    expect(authRepo.incrementTokenVersion).toHaveBeenCalledWith("user-1");
  });

  it("returns a replacement token carrying the new version", async () => {
    // Without this the caller would sign itself out along with every other
    // device, which isn't what "sign out everywhere" is supposed to do here.
    vi.mocked(authRepo.incrementTokenVersion).mockResolvedValue(userAfterBump(4) as never);

    const { token } = await signOutEverywhere("user-1");

    expect(verifyToken(token)).toMatchObject({
      userId: "user-1",
      companyId: "company-1",
      tokenVersion: 4,
    });
  });

  it("records who signed out everywhere in the audit log", async () => {
    vi.mocked(authRepo.incrementTokenVersion).mockResolvedValue(userAfterBump(1) as never);

    await signOutEverywhere("user-1");

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SIGNED_OUT_EVERYWHERE",
        actorEmail: "lam@example.com",
        targetId: "user-1",
      })
    );
  });
});
