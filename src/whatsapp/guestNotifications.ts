/** Guest-facing WhatsApp copy — always lead with the hotel name (not the platform). */

export function guestReceptionistHandoffMessage(hotelDisplayName: string): string {
  return `You're now chatting directly with ${hotelDisplayName}. A member of our team will reply shortly.`;
}

export function guestChatbotResumeMessage(hotelDisplayName: string): string {
  return `You're back with the ${hotelDisplayName} automated assistant. It can help with bookings and questions—reply *menu* anytime for the main options.`;
}
