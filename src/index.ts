import "dotenv/config";
import express from "express";
import path from "node:path";
import { apiRouter } from "./routes/api";
import { adminRouter } from "./routes/admin";
import { guestRouter } from "./routes/guest";
import { ownerRouter } from "./routes/owner";
import { whatsappWebhookRouter } from "./whatsapp/webhookRouter";

const app = express();
const port = Number(process.env.PORT ?? 3000);

// Stripe webhook requires raw body for signature verification.
app.use("/api/payments/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/static", express.static(path.join(process.cwd(), "src", "public")));

app.get("/", (_req, res) => {
  res.json({ name: "chatastay", status: "ok" });
});

app.use("/api", apiRouter);
app.use("/admin", adminRouter);
app.use("/guest", guestRouter);
app.use("/owner", ownerRouter);
app.use("/whatsapp/webhook", whatsappWebhookRouter);

app.listen(port, () => {
  console.log(`ChatAstay server listening on http://localhost:${port}`);
});
