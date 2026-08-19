-- Lets a user's existing JWTs be invalidated on demand ("sign out everywhere",
-- and password changes once that endpoint exists). Every token carries the
-- version it was signed with; requireAuth rejects the token when the two no
-- longer match.
--
-- Existing tokens were signed before this column existed, so they carry no
-- version and will be rejected — everyone signs in again once, then it's
-- invisible.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
