-- Optional WhatsApp delivery snapshot per ticket (dashboard display).

ALTER TABLE "OutletOrderTicket" ADD COLUMN "whatsappNotifyAt" DATETIME;
ALTER TABLE "OutletOrderTicket" ADD COLUMN "whatsappNotifyOk" BOOLEAN;
ALTER TABLE "OutletOrderTicket" ADD COLUMN "whatsappNotifyDetail" TEXT;
