export type ConversationState =
  | "new"
  | "collecting_dates"
  | "quoted"
  | "awaiting_confirmation"
  | "confirmed"
  | "cancelled";

export type ConversationEvent =
  | "message_received"
  | "dates_collected"
  | "quote_sent"
  | "guest_confirmed"
  | "guest_cancelled";

const transitions: Record<ConversationState, Partial<Record<ConversationEvent, ConversationState>>> =
  {
    new: { message_received: "collecting_dates" },
    collecting_dates: { dates_collected: "quoted" },
    quoted: { quote_sent: "awaiting_confirmation" },
    awaiting_confirmation: {
      guest_confirmed: "confirmed",
      guest_cancelled: "cancelled"
    },
    confirmed: {},
    cancelled: {}
  };

export function nextState(current: ConversationState, event: ConversationEvent): ConversationState {
  return transitions[current][event] ?? current;
}
