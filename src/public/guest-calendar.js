(function initGuestCalendar() {
  const root = document.getElementById("calendar-root");
  if (!root) return;

  const selectionText = document.getElementById("selectionText");
  const checkInInput = document.getElementById("checkInInput");
  const checkOutInput = document.getElementById("checkOutInput");
  const continueBtn = document.getElementById("continueBtn");
  const stepCheckIn = document.getElementById("stepCheckIn");
  const stepCheckOut = document.getElementById("stepCheckOut");
  const stepReady = document.getElementById("stepReady");

  if (!selectionText || !checkInInput || !checkOutInput) return;

  const month = root.getAttribute("data-month") || "";
  const token = root.getAttribute("data-token") || "";
  const hotelId = root.getAttribute("data-hotel-id") || "";
  const guests = root.getAttribute("data-guests") || "2";
  const rooms = root.getAttribute("data-rooms") || "1";
  const todayIso = new Date().toISOString().slice(0, 10);

  let checkIn = "";
  let checkOut = "";
  root.innerHTML = "<div class='calendar-loading'>Loading calendar</div>";

  function updateSelectionText() {
    if (stepCheckIn) stepCheckIn.className = "calendar-step";
    if (stepCheckOut) stepCheckOut.className = "calendar-step";
    if (stepReady) stepReady.className = "calendar-step";

    if (!checkIn && !checkOut) {
      selectionText.innerHTML = "<strong>Pick your stay:</strong> select check-in and check-out dates.";
      selectionText.classList.remove("active");
      if (stepCheckIn) stepCheckIn.classList.add("active");
      if (continueBtn) continueBtn.disabled = true;
      return;
    }
    if (checkIn && !checkOut) {
      selectionText.innerHTML = "<strong>Check-in selected:</strong> " + checkIn + ". Now choose check-out.";
      selectionText.classList.add("active");
      if (stepCheckIn) stepCheckIn.classList.add("done");
      if (stepCheckOut) stepCheckOut.classList.add("active");
      if (continueBtn) continueBtn.disabled = true;
      return;
    }
    selectionText.innerHTML = "<strong>Stay selected:</strong> " + checkIn + " to " + checkOut;
    selectionText.classList.add("active");
    if (stepCheckIn) stepCheckIn.classList.add("done");
    if (stepCheckOut) stepCheckOut.classList.add("done");
    if (stepReady) stepReady.classList.add("active", "done");
    if (continueBtn) continueBtn.disabled = false;
  }

  function paintSelectedState() {
    root.querySelectorAll("button[data-date]").forEach((el) => {
      const date = el.getAttribute("data-date") || "";
      el.classList.remove("selected");
      el.classList.remove("in-range");
      el.classList.remove("today");
      if (date === checkIn || date === checkOut) {
        el.classList.add("selected");
      } else if (checkIn && checkOut && date > checkIn && date < checkOut) {
        el.classList.add("in-range");
      }
      if (date === todayIso) {
        el.classList.add("today");
      }
    });
  }

  fetch(
    "/guest/calendar/availability?" +
      new URLSearchParams({
        month,
        token,
        hotelId,
        guests: String(guests),
        rooms: String(rooms)
      })
  )
    .then((res) => res.json())
    .then((payload) => {
      const days = Array.isArray(payload.days) ? payload.days : [];
      const title =
        "<div class='calendar-title-wrap'><h2 class='calendar-title'>" +
        (payload.monthLabel || month) +
        "</h2><span class='calendar-today-badge'>Today " +
        todayIso +
        "</span></div>";
      const weekday =
        "<div class='calendar-weekdays'>" +
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
          .map((d) => "<div class='calendar-weekday'>" + d + "</div>")
          .join("") +
        "</div>";
      const grid =
        "<div class='calendar-grid'>" +
        days
          .map((day) => {
            if (!day.inMonth) return "<div></div>";
            if (!day.available) {
              const reason = day.reason ? String(day.reason).replaceAll("_", " ").toLowerCase() : "fully booked";
              return (
                "<button type='button' disabled class='calendar-day disabled'>" +
                "<div class='calendar-day-num'>" +
                day.day +
                "</div><div class='calendar-day-meta'>Unavailable</div><div class='calendar-day-reason'>" +
                reason +
                "</div></button>"
              );
            }
            const price = day.cheapestRate ? "OMR " + Number(day.cheapestRate).toFixed(2) : "Available";
            return (
              "<button type='button' data-date='" +
              day.date +
              "' class='calendar-day'>" +
              "<div class='calendar-day-num'>" +
              day.day +
              "</div><div class='calendar-day-meta'>" +
              price +
              "</div></button>"
            );
          })
          .join("") +
        "</div>";
      root.innerHTML = title + weekday + grid;
      root.querySelectorAll("button[data-date]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const d = btn.getAttribute("data-date");
          if (!d) return;
          if (!checkIn || (checkIn && checkOut)) {
            checkIn = d;
            checkOut = "";
          } else if (d > checkIn) {
            checkOut = d;
          } else {
            checkIn = d;
            checkOut = "";
          }
          checkInInput.value = checkIn;
          checkOutInput.value = checkOut;
          updateSelectionText();
          paintSelectedState();
        });
      });
      updateSelectionText();
      paintSelectedState();
    })
    .catch(() => {
      root.innerHTML = "<p class='badge alert'>Could not load calendar availability.</p>";
    });
})();
