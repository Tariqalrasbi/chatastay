import "dotenv/config";

async function run(): Promise<void> {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const localBase = process.env.APP_BASE_URL || "http://localhost:3000";
  if (!verifyToken) {
    throw new Error("WHATSAPP_VERIFY_TOKEN is missing in .env");
  }

  const challenge = String(Date.now());
  const webhookUrl = `${localBase.replace(/\/$/, "")}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    verifyToken
  )}&hub.challenge=${encodeURIComponent(challenge)}`;
  const response = await fetch(webhookUrl);
  const body = await response.text();

  if (!response.ok || body.trim() !== challenge) {
    throw new Error(`Webhook verify failed. status=${response.status} body=${body}`);
  }

  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    throw new Error("WHATSAPP_TOKEN is missing in .env");
  }
  const graph = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}`);
  if (!graph.ok) {
    const error = await graph.text();
    throw new Error(`Graph token check failed: ${graph.status} ${error}`);
  }
  console.log("Webhook and token smoke check passed.");
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

