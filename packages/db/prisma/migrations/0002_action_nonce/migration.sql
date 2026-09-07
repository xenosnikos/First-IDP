-- CreateTable
CREATE TABLE "ActionNonce" (
    "nonce" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "ActionNonce_expiresAt_idx" ON "ActionNonce"("expiresAt");
