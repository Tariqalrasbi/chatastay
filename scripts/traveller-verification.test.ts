/**
 * Traveller email verification flow (in-process).
 * Run: tsx scripts/traveller-verification.test.ts
 */
import "dotenv/config";
import request from "supertest";
import { createHttpApp } from "../src/httpApp";
import { prisma } from "../src/db";
import { hashPassword } from "../src/core/authSecurity";
import {
  hashVerificationToken,
  issueAccountVerificationEmail,
  verifyAccountEmailToken
} from "../src/core/accountEmailVerification";

const testEmail = `verify-test-${Date.now()}@chatastay.test`;
const testPassword = "TestVerify2026!";

let failures = 0;

function fail(message: string): void {
  console.error(`\x1b[31m✖\x1b[0m ${message}`);
  failures += 1;
}

function ok(label: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${label}`);
}

function assert(cond: unknown, message: string): void {
  if (!cond) fail(message);
  else ok(message);
}

async function main(): Promise<void> {
  process.env.TRAVELLER_REQUIRE_EMAIL_VERIFICATION = "true";
  const app = createHttpApp();

  const account = await prisma.travellerAccount.create({
    data: {
      email: testEmail,
      fullName: "Verify Test",
      passwordHash: await hashPassword(testPassword),
      emailVerifiedAt: null
    }
  });

  try {
    const issue = await issueAccountVerificationEmail("traveller", account.id);
    assert(issue.verifyLink || issue.sent, "issueAccountVerificationEmail returns link or sent");

    const row = await prisma.travellerAccount.findUnique({
      where: { id: account.id },
      select: { emailVerificationTokenHash: true, emailVerificationExpiresAt: true }
    });
    assert(row?.emailVerificationTokenHash, "verification token hash stored");

    const loginRes = await request(app)
      .post("/guest/account/login")
      .type("form")
      .send({ email: testEmail, password: testPassword, next: "/guest/trips" });
    assert(loginRes.status === 302 && loginRes.headers.location?.includes("verify-pending"), "login redirects unverified to verify-pending");

    const cookie = loginRes.headers["set-cookie"];
    const agent = request.agent(app);
    if (Array.isArray(cookie)) {
      for (const c of cookie) agent.set("Cookie", c.split(";")[0] ?? "");
    } else if (cookie) {
      agent.set("Cookie", String(cookie).split(";")[0] ?? "");
    }

    const tripsRes = await agent.get("/guest/trips");
    assert(tripsRes.status === 302 && tripsRes.headers.location?.includes("verify-pending"), "My Trips blocked until verified");

    const tokenMatch = issue.verifyLink?.match(/token=([^&]+)/);
    const rawToken = tokenMatch ? decodeURIComponent(tokenMatch[1] ?? "") : "";
    if (!rawToken) {
      fail("could not extract verification token from link");
    } else {
      const verifyHttp = await request(app).get(`/guest/account/verify-email?token=${encodeURIComponent(rawToken)}`);
      assert(verifyHttp.status === 200 && verifyHttp.text.includes("Email verified"), "verify-email page shows success");

      const hash = hashVerificationToken(rawToken);
      const reuse = await verifyAccountEmailToken("traveller", rawToken);
      const stale = await prisma.travellerAccount.findFirst({ where: { emailVerificationTokenHash: hash } });
      assert(reuse.ok === false, "token cannot be reused");
      assert(!stale?.emailVerificationTokenHash, "token hash cleared after verify");

      const tripsAfter = await agent.get("/guest/trips");
      assert(tripsAfter.status === 200, "My Trips accessible after verification");
    }

    const forgotRes = await request(app)
      .post("/guest/account/forgot-password")
      .type("form")
      .send({ email: testEmail });
    assert(forgotRes.status === 302, "forgot-password still works for verified account");
  } finally {
    await prisma.travellerAccount.deleteMany({ where: { email: testEmail } });
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll traveller verification checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
