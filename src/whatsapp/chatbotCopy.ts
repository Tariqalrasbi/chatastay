import type { LightGuestMemory } from "../core/lightGuestMemory";

export type ChatLang = "en" | "ar" | "es" | "fr";

export function toChatLang(raw: string | undefined): ChatLang {
  if (raw === "ar" || raw === "es" || raw === "fr") return raw;
  return "en";
}

export function effectiveChatLang(raw: string | undefined): "ar" | "en" {
  return raw === "ar" ? "ar" : "en";
}

export function isArabicLang(lang: ChatLang | string | undefined): boolean {
  return lang === "ar";
}

// ——— Webhook legacy flow (en / ar / es / fr) ———

export type WebhookTextKey =
  | "welcome"
  | "askIntent"
  | "askDetails"
  | "invalidFormat"
  | "oneDateOnly"
  | "invalidGuests"
  | "invalidRooms"
  | "invalidDates"
  | "unavailable"
  | "quoteIntro"
  | "askConfirm"
  | "confirmed"
  | "editPrompt"
  | "qaIntro"
  | "qaExamples"
  | "qaContinue"
  | "menuLabel"
  | "bookingStatusMissing"
  | "bookingStatusPrefix";

export function getWebhookTexts(language: ChatLang, hotelName: string): Record<WebhookTextKey, string> {
  const h = hotelName;
  if (language === "ar") {
    return {
      welcome: `أهلاً بك في ${h}. كيف يمكننا مساعدتك اليوم؟`,
      askIntent: "للحجز، اختر «ابدأ الحجز» أو أرسل تواريخ الإقامة وعدد الضيوف مباشرة.",
      askDetails:
        "رائع. أرسل تفاصيل الحجز بجملة واحدة.\nمثال: من 2026-04-10 إلى 2026-04-12 لشخصين.\nيمكنك إضافة عدد الغرف والاسم في أي وقت.",
      invalidFormat:
        "لم نتمكن من قراءة كل التفاصيل. يُرجى إرسال تاريخ الوصول والمغادرة وعدد الضيوف. عدد الغرف اختياري (الافتراضي 1).",
      oneDateOnly: "وصلنا تاريخاً واحداً فقط. يُرجى إرسال تاريخي الوصول والمغادرة معاً.",
      invalidGuests: "عدد الضيوف يجب أن يكون بين 1 و16.",
      invalidRooms: "عدد الغرف يجب أن يكون بين 1 و6.",
      invalidDates: "تاريخ المغادرة يجب أن يكون بعد الوصول، والحد الأقصى للإقامة 30 ليلة.",
      unavailable: "عذراً، لا تتوفر غرفة مناسبة لهذه التواريخ أو لعدد الضيوف.",
      quoteIntro: "هذا ما هو متاح:",
      askConfirm: "هل تريد تأكيد الحجز؟ أرسل نعم أو لا.",
      confirmed: "شكراً لحجزك معنا. هذا رابط متابعة الحجز:",
      editPrompt: "ما الذي تود تعديله؟ أرسل التعديل بأي صيغة تناسبك.",
      qaIntro:
        "أنا المساعد الذكي للفندق. يمكنك السؤال عن الأسعار، المرافق، الموقع، أوقات الدخول والمغادرة، الدفع، وسياسة الإلغاء.",
      qaExamples: "مثال: هل يتوفر واي فاي؟ | ما سعر الليلة؟ | أين موقع الفندق؟",
      qaContinue: "يمكنك طرح المزيد من الأسئلة، أو اختر 1 لبدء الحجز.",
      menuLabel: "القائمة السريعة",
      bookingStatusMissing: "للاطلاع على الحجز، أرسل رقم الحجز أو افتح رابط المتابعة الذي وصلك.",
      bookingStatusPrefix: "آخر حالة لحجزك:"
    };
  }
  if (language === "es") {
    return {
      welcome: `Bienvenido a ${h}. ¿En qué podemos ayudarle hoy?`,
      askIntent: "Para reservar, escriba que desea reservar o pulse «Reservar ahora».",
      askDetails:
        "Perfecto. Envíe los datos en una frase simple.\nEjemplo: del 2026-04-10 al 2026-04-12 para 2 personas.\nPuede añadir habitaciones y su nombre cuando quiera.",
      invalidFormat:
        "No pudimos leer todos los datos. Envíe fecha de entrada, salida y número de huéspedes. Las habitaciones son opcionales (por defecto 1).",
      oneDateOnly: "Solo recibimos una fecha. Envíe entrada y salida juntas.",
      invalidGuests: "El número de huéspedes debe estar entre 1 y 16.",
      invalidRooms: "El número de habitaciones debe estar entre 1 y 6.",
      invalidDates: "La salida debe ser posterior a la entrada; estancia máxima 30 noches.",
      unavailable: "No hay habitación disponible para esas fechas o capacidad.",
      quoteIntro: "Disponibilidad encontrada:",
      askConfirm: "¿Desea confirmar la reserva? Responda SÍ o NO.",
      confirmed: "Gracias por reservar con nosotros. Aquí tiene su enlace de seguimiento:",
      editPrompt: "¿Qué desea cambiar? Envíe los datos actualizados como prefiera.",
      qaIntro:
        "Soy el asistente del hotel. Puede preguntar por tarifas, servicios, ubicación, horarios, pago y cancelación.",
      qaExamples: "Ejemplo: ¿Hay WiFi? | ¿Cuál es el precio por noche? | ¿Dónde está el hotel?",
      qaContinue: "Puede hacer más preguntas o elegir 1 para iniciar la reserva.",
      menuLabel: "Menú rápido",
      bookingStatusMissing: "Comparta su número de reserva o abra el enlace de seguimiento que recibió.",
      bookingStatusPrefix: "Estado más reciente de su reserva:"
    };
  }
  if (language === "fr") {
    return {
      welcome: `Bienvenue chez ${h}. Comment pouvons-nous vous aider aujourd'hui ?`,
      askIntent: "Pour réserver, dites que vous souhaitez réserver ou appuyez sur « Réserver ».",
      askDetails:
        "Parfait. Envoyez vos détails en une phrase.\nExemple : du 2026-04-10 au 2026-04-12 pour 2 personnes.\nVous pouvez ajouter le nombre de chambres et votre nom à tout moment.",
      invalidFormat:
        "Nous n'avons pas pu lire tous les détails. Envoyez les dates d'arrivée et de départ et le nombre de voyageurs. Chambres optionnelles (défaut 1).",
      oneDateOnly: "Une seule date reçue. Envoyez l'arrivée et le départ ensemble.",
      invalidGuests: "Le nombre de voyageurs doit être entre 1 et 16.",
      invalidRooms: "Le nombre de chambres doit être entre 1 et 6.",
      invalidDates: "Le départ doit être après l'arrivée ; séjour maximum 30 nuits.",
      unavailable: "Aucune chambre disponible pour ces dates ou cette capacité.",
      quoteIntro: "Disponibilité trouvée :",
      askConfirm: "Souhaitez-vous confirmer ? Répondez OUI ou NON.",
      confirmed: "Merci pour votre réservation. Voici votre lien de suivi :",
      editPrompt: "Que souhaitez-vous modifier ? Envoyez les nouvelles informations librement.",
      qaIntro:
        "Je suis l'assistant de l'hôtel. Posez vos questions sur les tarifs, services, emplacement, horaires, paiement et annulation.",
      qaExamples: "Exemple : Y a-t-il le WiFi ? | Quel est le tarif par nuit ? | Où se trouve l'hôtel ?",
      qaContinue: "Vous pouvez poser d'autres questions ou choisir 1 pour réserver.",
      menuLabel: "Menu rapide",
      bookingStatusMissing: "Partagez votre numéro de réservation ou ouvrez le lien de suivi reçu.",
      bookingStatusPrefix: "Dernier statut de votre réservation :"
    };
  }
  return {
    welcome: `Welcome to ${h}. How can we help you today?`,
    askIntent: "To book a stay, tap Book now or tell us your dates and guest count.",
    askDetails:
      "Great — please share your stay details in one message.\nExample: 2026-04-10 to 2026-04-12 for 2 guests.\nYou can add room count and your name anytime.",
    invalidFormat:
      "We couldn't read everything yet. Please send check-in, check-out, and guest count. Room count is optional (default 1).",
    oneDateOnly: "We only received one date. Please send both check-in and check-out.",
    invalidGuests: "Guest count must be between 1 and 16.",
    invalidRooms: "Room count must be between 1 and 6.",
    invalidDates: "Check-out must be after check-in. Maximum stay is 30 nights.",
    unavailable: "No suitable room is available for those dates and guest count.",
    quoteIntro: "Here's what we found:",
    askConfirm: "Would you like to confirm this booking? Reply YES or NO.",
    confirmed: "Thank you for booking with us. Here is your booking link:",
    editPrompt: "What would you like to change? Send the updated details in any way you prefer.",
    qaIntro:
      "I'm the hotel assistant. Ask about rates, amenities, location, check-in/out times, payment, and cancellation policy.",
    qaExamples: "Example: Is there WiFi? | What's the nightly rate? | Where is the hotel located?",
    qaContinue: "Ask more questions anytime, or choose 1 to start a booking.",
    menuLabel: "Quick menu",
    bookingStatusMissing: "Share your booking ID or open the follow-up link we sent you.",
    bookingStatusPrefix: "Your latest booking status:"
  };
}

export function getPrimaryButtons(language: ChatLang): Array<{ id: string; title: string }> {
  if (language === "ar") {
    return [
      { id: "book_now", title: "ابدأ الحجز" },
      { id: "ask_question", title: "لدي سؤال" },
      { id: "talk_agent", title: "الاستقبال" }
    ];
  }
  if (language === "es") {
    return [
      { id: "book_now", title: "Reservar" },
      { id: "ask_question", title: "Pregunta" },
      { id: "talk_agent", title: "Recepción" }
    ];
  }
  if (language === "fr") {
    return [
      { id: "book_now", title: "Réserver" },
      { id: "ask_question", title: "Question" },
      { id: "talk_agent", title: "Réception" }
    ];
  }
  return [
    { id: "book_now", title: "Book now" },
    { id: "ask_question", title: "Ask a question" },
    { id: "talk_agent", title: "Reception" }
  ];
}

export function getConfirmButtons(language: ChatLang): Array<{ id: string; title: string }> {
  if (language === "ar") {
    return [
      { id: "confirm_booking", title: "تأكيد الحجز" },
      { id: "edit_booking", title: "تعديل البيانات" },
      { id: "talk_agent", title: "الاستقبال" }
    ];
  }
  if (language === "es") {
    return [
      { id: "confirm_booking", title: "Confirmar" },
      { id: "edit_booking", title: "Editar" },
      { id: "talk_agent", title: "Recepción" }
    ];
  }
  if (language === "fr") {
    return [
      { id: "confirm_booking", title: "Confirmer" },
      { id: "edit_booking", title: "Modifier" },
      { id: "talk_agent", title: "Réception" }
    ];
  }
  return [
    { id: "confirm_booking", title: "Confirm" },
    { id: "edit_booking", title: "Edit details" },
    { id: "talk_agent", title: "Reception" }
  ];
}

export function getPrimaryMenuHint(language: ChatLang): string {
  if (language === "ar") return "1) ابدأ الحجز\n2) اسأل المساعد\n3) تحدث مع الاستقبال";
  if (language === "es") return "1) Reservar\n2) Preguntar al asistente\n3) Hablar con recepción";
  if (language === "fr") return "1) Réserver\n2) Poser une question\n3) Parler à la réception";
  return "1) Book now\n2) Ask the assistant\n3) Talk to reception";
}

export function getConfirmMenuHint(language: ChatLang): string {
  if (language === "ar") return "اختر رقماً:\n1) تأكيد الحجز\n2) تعديل البيانات\n3) الاستقبال";
  if (language === "es") return "Responda con un número:\n1) Confirmar\n2) Editar\n3) Recepción";
  if (language === "fr") return "Répondez par un chiffre :\n1) Confirmer\n2) Modifier\n3) Réception";
  return "Reply with a number:\n1) Confirm booking\n2) Edit details\n3) Reception";
}

export function buildMissingFieldsPrompt(language: ChatLang, missing: string[]): string {
  const has = (key: string) => missing.includes(key);
  if (language === "ar") {
    const parts: string[] = [];
    if (has("dates")) parts.push("تاريخ الوصول والمغادرة");
    if (has("guests")) parts.push("عدد الضيوف");
    if (has("rooms")) parts.push("عدد الغرف");
    return `يُرجى إرسال: ${parts.join("، ")}.`;
  }
  if (language === "es") {
    const parts: string[] = [];
    if (has("dates")) parts.push("fechas de entrada y salida");
    if (has("guests")) parts.push("número de huéspedes");
    if (has("rooms")) parts.push("número de habitaciones");
    return `Por favor envíe: ${parts.join(", ")}.`;
  }
  if (language === "fr") {
    const parts: string[] = [];
    if (has("dates")) parts.push("dates d'arrivée et de départ");
    if (has("guests")) parts.push("nombre de voyageurs");
    if (has("rooms")) parts.push("nombre de chambres");
    return `Veuillez indiquer : ${parts.join(", ")}.`;
  }
  const parts: string[] = [];
  if (has("dates")) parts.push("check-in and check-out dates");
  if (has("guests")) parts.push("guest count");
  if (has("rooms")) parts.push("room count");
  return `Please send: ${parts.join(", ")}.`;
}

export function buildCheckInPickerText(language: ChatLang, options: string[]): string {
  const lines = options.map((date, idx) => `${idx + 1}) ${date}`);
  if (language === "ar") {
    return `تواريخ الوصول المتاحة. اختر من القائمة أو أرسل التاريخ (YYYY-MM-DD):\n${lines.join("\n")}`;
  }
  if (language === "es") {
    return `Fechas de entrada disponibles. Elija en la lista o envíe la fecha (AAAA-MM-DD):\n${lines.join("\n")}`;
  }
  if (language === "fr") {
    return `Dates d'arrivée disponibles. Choisissez dans la liste ou envoyez la date (AAAA-MM-JJ) :\n${lines.join("\n")}`;
  }
  return `Available check-in dates. Pick from the list or type the date (YYYY-MM-DD):\n${lines.join("\n")}`;
}

export function buildCheckOutPickerText(language: ChatLang, options: string[]): string {
  const lines = options.map((date, idx) => `${idx + 1}) ${date}`);
  if (language === "ar") {
    return `تواريخ المغادرة المتاحة لهذا الوصول. اختر من القائمة أو أرسل التاريخ (YYYY-MM-DD):\n${lines.join("\n")}`;
  }
  if (language === "es") {
    return `Fechas de salida para su entrada. Elija en la lista o envíe la fecha (AAAA-MM-DD):\n${lines.join("\n")}`;
  }
  if (language === "fr") {
    return `Dates de départ pour votre arrivée. Choisissez dans la liste ou envoyez la date (AAAA-MM-JJ) :\n${lines.join("\n")}`;
  }
  return `Available check-out dates for your check-in. Pick from the list or type the date (YYYY-MM-DD):\n${lines.join("\n")}`;
}

// ——— Main conversation controller (en / ar) ———

export function getLanguageSelectPrompt(_lang?: ChatLang): string {
  return "اختر لغتك / Choose your language:";
}

export function getLanguageSelectFallback(_lang?: ChatLang): string {
  return "اختر لغتك / Choose your language:\n• العربية\n• English";
}

export function getMainMenuBody(hotelName: string, lang: "ar" | "en"): string {
  if (lang === "ar") {
    return `أهلاً بك في ${hotelName}.\nاختر الخدمة التي تحتاجها:`;
  }
  return `Welcome to ${hotelName}.\nWhat would you like to do?`;
}

export function buildMainMenuMessage(hotelName: string, lang: "ar" | "en"): string {
  if (lang === "ar") {
    return [
      `أهلاً بك في ${hotelName}.`,
      "اختر الخدمة التي تحتاجها:",
      "1) حجز إقامة",
      "2) معلومات الفندق والموقع",
      "3) تصفح قائمة المطعم",
      "4) طلب طعام (للنزلاء)",
      "5) تغيير اللغة",
      "6) التحدث مع الاستقبال"
    ].join("\n");
  }
  return [
    `Welcome to ${hotelName}.`,
    "What would you like to do?",
    "1) Book a stay",
    "2) Hotel info & location",
    "3) Browse restaurant menu",
    "4) In-house food order (guests)",
    "5) Change language",
    "6) Chat with reception"
  ].join("\n");
}

export function welcomeBackPrefix(lang: "ar" | "en"): string {
  return lang === "ar"
    ? "أهلاً بعودتك — يسعدنا تواصلك معنا مجدداً.\n\n"
    : "Welcome back — great to hear from you again.\n\n";
}

export function getBookingModeEntry(lang: "ar" | "en"): string {
  if (lang === "ar") {
    return "سأساعدك في الحجز. يمكنك السؤال عن أنواع الغرف أو التوفر. للبدء، أرسل التواريخ وعدد الضيوف — مثال: 10–12 أبريل لشخصين.";
  }
  return "I'll help you book a stay. Ask about room types or availability anytime. To start, send your dates and guest count — e.g. 10–12 April for 2 guests.";
}

export function getBookingSubmenuBody(lang: "ar" | "en"): string {
  return lang === "ar" ? "ماذا تود أن تفعل؟" : "What would you like to do?";
}

export function getBookingSubmenuFallbackList(lang: "ar" | "en"): string {
  if (lang === "ar") {
    return [
      getBookingSubmenuBody(lang),
      "1) التحقق من التوفر",
      "2) عرض أنواع الغرف",
      "3) عرض العروض",
      "4) معلومات الفندق والموقع"
    ].join("\n");
  }
  return [
    getBookingSubmenuBody(lang),
    "1) Check availability",
    "2) View room types",
    "3) View offers",
    "4) View location and hotel information"
  ].join("\n");
}

export function bookingStartPrompt(
  lang: "ar" | "en",
  opts?: { memory: LightGuestMemory; confirmedStayCount: number }
): string {
  if (lang === "ar") {
    const lines = [
      "يسعدنا مساعدتك في الحجز.",
      "أرسل تاريخ الوصول والمغادرة وعدد الضيوف.",
      "أمثلة:",
      "- من 2026-04-10 إلى 2026-04-12 لشخصين",
      "- شخصان من 10 أبريل إلى 12 أبريل"
    ];
    if (opts && opts.confirmedStayCount >= 1) {
      const room = opts.memory.preferredRoomTypeName?.trim();
      if (room && room.length > 2) {
        lines.splice(
          1,
          0,
          `أهلاً بعودتك — عندما تحدد التواريخ يمكننا البحث عن توفر مشابه لـ ${room} إن رغبت.`
        );
      } else {
        lines.splice(1, 0, "أهلاً بعودتك — يسعدنا مساعدتك في إقامة جديدة.");
      }
    }
    return lines.join("\n");
  }
  const base = [
    "Happy to help with your booking.",
    "Please send check-in, check-out, and guest count.",
    "Examples:",
    "- 2026-04-10 to 2026-04-12 for 2 guests",
    "- 2 guests from 10 April to 12 April"
  ];
  if (opts && opts.confirmedStayCount >= 1) {
    const room = opts.memory.preferredRoomTypeName?.trim();
    if (room && room.length > 2) {
      base.splice(
        1,
        0,
        `Welcome back — once you share dates, we can check availability similar to ${room} if you'd like.`
      );
    } else {
      base.splice(1, 0, "Welcome back — we'd be glad to help with another stay.");
    }
  }
  return base.join("\n");
}

export function missingBookingDetailsPrompt(
  lang: "ar" | "en",
  parsed: { checkIn?: Date | null; checkOut?: Date | null; guestCount?: number }
): string {
  const missingDates = !parsed.checkIn || !parsed.checkOut;
  const missingGuests = parsed.guestCount === undefined;
  if (lang === "ar") {
    if (missingDates && missingGuests) {
      return "يُرجى إرسال تاريخ الوصول والمغادرة وعدد الضيوف. مثال: 2026-04-10 إلى 2026-04-12 لشخصين.";
    }
    if (missingDates) return "يُرجى إرسال تاريخ الوصول والمغادرة.";
    return "كم عدد الضيوف؟";
  }
  if (missingDates && missingGuests) {
    return "Please send check-in, check-out, and guest count. Example: 2026-04-10 to 2026-04-12 for 2 guests.";
  }
  if (missingDates) return "Please send your check-in and check-out dates.";
  return "How many guests will be staying?";
}

/** Booking-flow copy used across the WhatsApp reservation journey. */
export function bookingCopy(langRaw: string | undefined) {
  const ar = effectiveChatLang(langRaw) === "ar";
  return {
    noSingleRoomPrefix: ar ? "لا توجد غرفة واحدة مناسبة لهذا العدد من الضيوف." : "No single room fits this group.",
    largestOptions: ar ? "أكبر الخيارات المتاحة:" : "Our largest available options:",
    splitPrompt: ar
      ? "يمكننا توزيع الضيوف على أكثر من غرفة. اختر عدد الغرف للمتابعة:"
      : "We can split guests across multiple rooms. How many rooms would you like?",
    splitButton: ar ? "تقسيم الغرف" : "Split rooms",
    splitSection: ar ? "خيارات الغرف" : "Room options",
    splitInto: (rooms: number) => (ar ? `تقسيم إلى ${rooms} غرف` : `Split into ${rooms} rooms`),
    splitDesc: (rooms: number, guests: number) =>
      ar ? `حوالي ${Math.ceil(guests / rooms)} ضيف لكل غرفة` : `About ${Math.ceil(guests / rooms)} guests per room`,
    changeGuests: ar ? "تغيير عدد الضيوف" : "Change guests",
    changeGuestsDesc: ar ? "العودة للبالغين والأطفال" : "Back to adults & children",
    splitFallback: ar
      ? "اكتب عدد الغرف (مثل 2 أو 3)، أو اكتب back لتغيير عدد الضيوف."
      : "Reply with the number of rooms (e.g. 2 or 3), or back to change guests.",
    invalidSplit: ar ? "اختر عدد الغرف من القائمة أو اكتب 2 أو 3." : "Choose a room count from the list, or reply 2 or 3.",
    noSplitAvailability: ar
      ? "عذراً، لا تتوفر غرف كافية لهذه التواريخ. جرّب عدد غرف أو تواريخ أخرى."
      : "Sorry, there aren't enough rooms for those dates. Try different dates or room count.",
    noSingleRoomChoiceBody: ar
      ? "لا توجد غرفة واحدة تناسب هذا العدد. ماذا تفضّل؟"
      : "No single room fits this group. What would you like to do?",
    splitNow: ar ? "تقسيم الغرف الآن" : "Split rooms now",
    splitNowDesc: ar ? "اختر غرفتين أو أكثر وأكمل الحجز" : "Choose 2+ rooms and continue",
    talkReception: ar ? "الاستقبال" : "Reception",
    talkReceptionDesc: ar ? "سيتواصل معك موظف مباشرة" : "A team member will assist you",
    noAvailabilityBody: ar
      ? "لا توجد غرف متاحة لهذا الاختيار. ماذا تود تغييره؟"
      : "Nothing is available for this choice. What would you like to change?",
    availabilityRecoveryButton: ar ? "تعديل الطلب" : "Change request",
    changeDates: ar ? "تغيير التواريخ" : "Change dates",
    changeDatesDesc: ar ? "اختر وصولاً ومغادرة جديدين" : "Pick new check-in / check-out",
    changeRooms: ar ? "تغيير عدد الغرف" : "Change room count",
    changeRoomsDesc: ar ? "جرّب عدداً أكبر أو أصغر" : "Try more or fewer rooms",
    changeRoomType: ar ? "تغيير نوع الغرفة" : "Change room type",
    changeRoomTypeDesc: ar ? "اختر نوع غرفة آخر" : "Pick another room type",
    changeMenuBody: ar ? "ماذا تود تغييره في الحجز؟" : "What would you like to change?",
    changeMenuButton: ar ? "تعديل الحجز" : "Change booking",
    changeMealPlan: ar ? "تغيير الوجبات" : "Change meal plan",
    changeMealPlanDesc: ar ? "غرفة فقط أو باقات إقامة" : "Room only or board options",
    changePayment: ar ? "تغيير الدفع" : "Change payment",
    changePaymentDesc: ar ? "الدفع الآن أو في الفندق" : "Pay now or at the hotel",
    paymentChoiceBody: ar ? "كيف تفضّل إتمام الدفع؟" : "How would you like to pay?",
    payOnline: ar ? "الدفع الإلكتروني" : "Pay online",
    payOnlineDesc: ar ? "نرسل رابط دفع آمن بعد التأكيد" : "Secure payment link after confirmation",
    payAtHotel: ar ? "الدفع في الفندق" : "Pay at hotel",
    payAtHotelDesc: ar ? "يكمل الاستقبال الدفع لاحقاً" : "Reception will follow up",
    nearestDatesIntro: ar ? "أقرب تواريخ متاحة:" : "Nearest available dates:",
    tryDate: (date: string) => (ar ? `جرّب ${date}` : `Try ${date}`),
    checkInBody: ar
      ? "اختر تاريخ *الوصول*:\n\nافتح القائمة واختر التاريخ، أو *تاريخ آخر* واكتب YYYY-MM-DD."
      : "Choose your *check-in* date:\n\nOpen the list and tap a date, or *Other date* to type YYYY-MM-DD.",
    checkInButton: ar ? "تاريخ الوصول" : "Check-in",
    checkOutBody: ar
      ? "اختر تاريخ *المغادرة* (بعد الوصول):\n\nافتح القائمة، أو *تاريخ آخر* واكتب YYYY-MM-DD."
      : "Choose your *check-out* date (after check-in):\n\nOpen the list, or *Other date* to type YYYY-MM-DD.",
    checkOutButton: ar ? "تاريخ المغادرة" : "Check-out",
    adultsPrompt: ar ? "كم عدد البالغين؟" : "How many adults?",
    adultsButton: ar ? "البالغون" : "Adults",
    adultsFallback: ar ? "اكتب عدد البالغين، مثل 2." : "Reply with adults, e.g. 2.",
    childrenPrompt: ar ? "كم عدد الأطفال؟" : "How many children?",
    childrenButton: ar ? "الأطفال" : "Children",
    childrenFallback: ar ? "اكتب عدد الأطفال، مثل 0 أو 2." : "Reply with children, e.g. 0 or 2."
  };
}
