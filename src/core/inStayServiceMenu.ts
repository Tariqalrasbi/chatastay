/**
 * In-stay WhatsApp list — max 10 rows total across sections (Meta limit).
 * Row ids are handled in `conversationController` (`tryHandleInStayServiceListReply`).
 */
export const IN_STAY_SERVICE_MESSAGE_SECTIONS: Array<{
  title: string;
  rows: Array<{ id: string; title: string; description: string }>;
}> = [
  {
    title: "Bill & dining",
    rows: [
      { id: "isv_invoice", title: "View bill / summary", description: "Room, meals, balance" },
      { id: "isv_browse_menus", title: "Restaurant & café menus", description: "Browse items" },
      { id: "isv_order_meal", title: "Order food (kitchen)", description: "À la carte to folio" },
      { id: "isv_book_meal", title: "Book meal time", description: "Buffet / set times" },
      { id: "isv_room_service", title: "Room service", description: "Order to your room" }
    ]
  },
  {
    title: "Services & help",
    rows: [
      { id: "isv_bike", title: "Bike / activities", description: "Rentals & tours" },
      { id: "isv_hk", title: "Housekeeping", description: "Room refresh" },
      { id: "isv_extras", title: "Extra items", description: "Pillows, towels, water…" },
      { id: "isv_complaint", title: "Submit complaint", description: "Manager follow-up" },
      { id: "isv_reception", title: "Talk to reception", description: "Staff handoff" }
    ]
  }
];

export const IN_STAY_SERVICE_LIST_ROWS = IN_STAY_SERVICE_MESSAGE_SECTIONS.flatMap((s) => s.rows);
