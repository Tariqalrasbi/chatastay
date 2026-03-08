export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: {
    body: string;
  };
  type: string;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      field: string;
      value: {
        messaging_product: string;
        metadata?: {
          display_phone_number: string;
          phone_number_id: string;
        };
        messages?: WhatsAppTextMessage[];
      };
    }>;
  }>;
}
