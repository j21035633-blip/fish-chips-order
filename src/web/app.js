// Customer order app. No framework, no build step — this page is opened by
// scanning a QR code at the table, so it should load on a bad connection.

const view = document.getElementById("view");
const cartPanel = document.getElementById("cart-panel");
const cartBody = document.getElementById("cart-body");
const cartTotalEl = document.getElementById("cart-total");
const cartCountEl = document.getElementById("cart-count");
const cartToggle = document.getElementById("cart-toggle");
const cartClose = document.getElementById("cart-close");
const checkoutButton = document.getElementById("checkout-button");
const scrim = document.getElementById("scrim");
const itemDialog = document.getElementById("item-dialog");
const itemDialogBody = document.getElementById("item-dialog-body");
const itemQtyEl = document.getElementById("item-qty");
const itemPriceEl = document.getElementById("item-price");
const itemAddButton = document.getElementById("item-add");

const CART_KEY = "fishchips.cartId";

const state = {
  menu: null,
  cart: null,
  dialogItem: null,
  dialogQty: 1,
  pendingOrder: null,
};

// ---------------------------------------------------------------- utilities

/** Builds an element. Text goes in via textContent, never innerHTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
    error.code = body.error;
    error.status = response.status;
    throw error;
  }
  return body;
}

function centsFromPrice(text) {
  // Prices arrive pre-formatted from the server ("RM16.90"); this is only used
  // for the live total in the options dialog.
  return Math.round(Number(String(text).replace(/[^0-9.-]/g, "")) * 100);
}

function formatSen(sen) {
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  return `${sign}RM${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// -------------------------------------------------------------------- cart

async function ensureCart() {
  const stored = localStorage.getItem(CART_KEY);
  if (stored) {
    try {
      const { cart } = await api(`/api/carts/${stored}`);
      state.cart = cart;
      return cart;
    } catch (error) {
      // A restarted server drops in-memory carts; quietly start a new one.
      if (error.status !== 404) console.warn(error);
    }
  }
  const { cartId } = await api("/api/carts", { method: "POST" });
  localStorage.setItem(CART_KEY, cartId);
  const { cart } = await api(`/api/carts/${cartId}`);
  state.cart = cart;
  return cart;
}

function setCart(cart) {
  state.cart = cart;
  renderCart();
}

function renderCart() {
  const cart = state.cart;
  const lines = cart?.lines ?? [];

  cartCountEl.textContent = String(cart?.itemCount ?? 0);
  cartTotalEl.textContent = cart?.total ?? "RM0.00";
  cartToggle.hidden = lines.length === 0;
  checkoutButton.disabled = lines.length === 0;

  cartBody.replaceChildren(
    lines.length === 0
      ? el("p", { class: "empty", text: "Nothing in here yet." })
      : el(
          "div",
          {},
          lines.map((line) =>
            el("div", { class: "cart-line" }, [
              el("div", { class: "cart-line-main" }, [
                el("div", { class: "cart-line-name", text: `${line.quantity}× ${line.name}` }),
                line.options.length > 0
                  ? el("div", {
                      class: "cart-line-opts",
                      text: line.options.map((option) => option.choiceName).join(", "),
                    })
                  : null,
                line.note ? el("div", { class: "cart-line-opts", text: `Note: ${line.note}` }) : null,
                el("div", { class: "qty", style: "margin-top:8px" }, [
                  el("button", {
                    class: "icon-button",
                    type: "button",
                    "aria-label": "Fewer",
                    text: "−",
                    onClick: () => changeQuantity(line, line.quantity - 1),
                  }),
                  el("output", { text: String(line.quantity) }),
                  el("button", {
                    class: "icon-button",
                    type: "button",
                    "aria-label": "More",
                    text: "+",
                    onClick: () => changeQuantity(line, line.quantity + 1),
                  }),
                ]),
              ]),
              el("div", { class: "cart-line-total", text: line.lineTotal }),
            ]),
          ),
        ),
  );
}

async function changeQuantity(line, quantity) {
  try {
    const { cart } = await api(`/api/carts/${state.cart.cartId}/lines/${line.lineId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    });
    setCart(cart);
  } catch (error) {
    alert(error.message);
  }
}

function openCart() {
  cartPanel.hidden = false;
  scrim.hidden = false;
}

function closeCart() {
  cartPanel.hidden = true;
  scrim.hidden = true;
}

// -------------------------------------------------------------- menu view

async function renderMenuView() {
  const [{ categories }] = await Promise.all([api("/api/menu"), ensureCart()]);
  state.menu = categories;

  view.replaceChildren(
    ...categories.map((category) =>
      el("section", { class: "category" }, [
        el("div", { class: "category-head" }, [
          el("h2", { text: category.name }),
          el("p", { text: category.blurb }),
        ]),
        ...category.items.map((item) =>
          el("button", { class: "item", type: "button", onClick: () => openItem(item) }, [
            el("div", { class: "item-main" }, [
              el("div", { class: "item-name", text: item.name }),
              el("div", { class: "item-desc", text: item.description }),
              item.tags.length > 0
                ? el(
                    "div",
                    { class: "tags" },
                    item.tags
                      .filter((tag) => ["signature", "popular", "new", "spicy"].includes(tag))
                      .map((tag) => el("span", { class: `tag ${tag}`, text: tag })),
                  )
                : null,
            ]),
            el("div", { class: "item-price", text: item.price }),
          ]),
        ),
      ]),
    ),
  );

  renderCart();
}

// ------------------------------------------------------------ item dialog

function openItem(item) {
  state.dialogItem = item;
  state.dialogQty = 1;

  itemDialogBody.replaceChildren(
    el("h3", { text: item.name }),
    el("p", { class: "flavour", text: item.flavourNotes }),
    el("p", { class: "portion", text: item.portionSummary }),
    item.allergens.length > 0
      ? el("p", { class: "allergens", text: `Contains: ${item.allergens.join(", ")}` })
      : null,
    ...item.optionGroups.map((group) => renderGroup(group)),
  );

  itemQtyEl.textContent = "1";
  updateDialogPrice();
  itemDialog.showModal();
}

function renderGroup(group) {
  const pickOne = group.maxSelections === 1;
  const hint = pickOne
    ? group.required
      ? "pick one"
      : "optional"
    : `pick up to ${group.maxSelections}`;

  return el("div", { class: "group", "data-group": group.id }, [
    el("div", { class: "group-name" }, [
      document.createTextNode(group.name + " "),
      el("span", { class: "group-hint", text: `(${hint})` }),
    ]),
    ...group.choices
      .filter((choice) => choice.available)
      .map((choice) =>
        el("label", { class: "choice" }, [
          el("input", {
            type: pickOne ? "radio" : "checkbox",
            name: group.id,
            value: choice.id,
            checked: pickOne && choice.isDefault,
            "data-delta": String(choice.priceDeltaSen),
            onChange: updateDialogPrice,
          }),
          el("span", { class: "choice-name", text: choice.name }),
          choice.priceDeltaSen !== 0
            ? el("span", { class: "choice-delta", text: choice.priceDelta })
            : null,
        ]),
      ),
  ]);
}

function selectedChoices() {
  return [...itemDialogBody.querySelectorAll(".group")].flatMap((groupEl) =>
    [...groupEl.querySelectorAll("input:checked")].map((input) => ({
      groupId: groupEl.dataset.group,
      choiceId: input.value,
      delta: Number(input.dataset.delta),
    })),
  );
}

function updateDialogPrice() {
  const base = centsFromPrice(state.dialogItem.price);
  const deltas = selectedChoices().reduce((total, choice) => total + choice.delta, 0);
  itemPriceEl.textContent = formatSen((base + deltas) * state.dialogQty);
}

itemDialog.addEventListener("click", (event) => {
  const step = event.target.closest("[data-qty]");
  if (!step) return;
  state.dialogQty = Math.min(20, Math.max(1, state.dialogQty + Number(step.dataset.qty)));
  itemQtyEl.textContent = String(state.dialogQty);
  updateDialogPrice();
});

itemAddButton.addEventListener("click", async () => {
  const selections = selectedChoices().map(({ groupId, choiceId }) => ({ groupId, choiceId }));
  try {
    const { cart } = await api(`/api/carts/${state.cart.cartId}/lines`, {
      method: "POST",
      body: JSON.stringify({ itemId: state.dialogItem.id, quantity: state.dialogQty, selections }),
    });
    itemDialog.close();
    setCart(cart);
    openCart();
  } catch (error) {
    alert(error.message);
  }
});

// --------------------------------------------------------- checkout view

async function renderCheckoutView() {
  closeCart();
  const [{ methods }] = await Promise.all([api("/api/payments/methods"), ensureCart()]);
  const cart = state.cart;

  if (!cart || cart.lines.length === 0) {
    navigate("/");
    return;
  }

  const errorEl = el("p", { class: "error", hidden: true });

  const payButton = el("button", {
    class: "primary wide",
    type: "button",
    text: `Pay ${cart.total}`,
    onClick: () => pay(errorEl, payButton),
  });

  view.replaceChildren(
    el("h1", { style: "font-size:22px;margin-bottom:16px", text: "Checkout" }),

    el("section", { class: "panel" }, [
      el("h2", { text: "Your order" }),
      ...cart.lines.map((line) =>
        el("div", { class: "summary-line" }, [
          el("span", { text: `${line.quantity}× ${line.name}` }),
          el("span", { text: line.lineTotal }),
        ]),
      ),
      el("div", { class: "summary-total" }, [el("span", { text: "Total" }), el("span", { text: cart.total })]),
    ]),

    el("section", { class: "panel" }, [
      el("label", { class: "field" }, [
        el("span", { text: "Name for pickup" }),
        el("input", { type: "text", id: "customer-name", placeholder: "e.g. Aisyah", maxlength: "60" }),
      ]),

      el("h2", { text: "How would you like to pay?" }),
      el(
        "div",
        { class: "methods" },
        methods.map((option, index) =>
          el("label", { class: "method" }, [
            el("input", { type: "radio", name: "method", value: option.method, checked: index === 0 }),
            el("div", {}, [
              el("div", { class: "method-label", text: option.label }),
              el("div", { class: "method-desc", text: option.description }),
              el("div", { class: "method-brands", text: option.brands.join(" · ") }),
              option.simulated ? el("div", { class: "method-sim", text: "Test mode" }) : null,
            ]),
          ]),
        ),
      ),
    ]),

    payButton,
    errorEl,
    el("button", { class: "secondary wide", type: "button", style: "margin-top:10px", text: "Back to menu", onClick: () => navigate("/") }),
  );
}

async function pay(errorEl, payButton) {
  errorEl.hidden = true;
  payButton.disabled = true;
  payButton.textContent = "Starting payment…";

  const method = view.querySelector('input[name="method"]:checked')?.value;
  const customerName = view.querySelector("#customer-name")?.value.trim();

  try {
    // Placing the order and starting the payment are two calls. If the second
    // fails, keep the order we already created — retrying must not place a
    // second one, and the cart it came from is gone by then.
    if (!state.pendingOrder) {
      const { order } = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({ cartId: state.cart.cartId, ...(customerName ? { customerName } : {}) }),
      });
      state.pendingOrder = order;

      // The cart is spent once the order exists; drop it so a back-button press
      // does not try to check out an order that has already been placed.
      localStorage.removeItem(CART_KEY);
      state.cart = null;
    }

    const order = state.pendingOrder;

    const { payment } = await api(`/api/orders/${order.id}/payment`, {
      method: "POST",
      body: JSON.stringify({ method }),
    });

    if (payment?.checkoutUrl) {
      window.location.href = payment.checkoutUrl;
      return;
    }
    state.pendingOrder = null;
    navigate(`/order/${order.id}`);
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    payButton.disabled = false;
    payButton.textContent = "Try again";
  }
}

// ------------------------------------------------------------ order view

let pollTimer = null;

async function renderOrderView(orderId) {
  closeCart();
  cartToggle.hidden = true;
  clearInterval(pollTimer);

  const draw = (order) => {
    const paid = order.paymentStatus === "paid";

    view.replaceChildren(
      el("section", { class: "panel", style: "text-align:center" }, [
        el("p", { class: "muted", text: "Order" }),
        el("div", { class: "reference", text: order.reference }),
        el("div", { style: "margin-top:12px" }, [
          el("span", { class: `status ${order.paymentStatus}`, text: statusLabel(order.paymentStatus) }),
        ]),
        paid
          ? el("p", { style: "margin:16px 0 0", text: "Paid — we're on it. Show this screen at the counter." })
          : el("p", { class: "muted", style: "margin:16px 0 0", text: "Waiting for payment to confirm…" }),
      ]),

      order.payment?.simulated && !paid
        ? el("section", { class: "panel" }, [
            el("div", { class: "notice", text: "Test mode — no provider keys configured, so no money moves." }),
            el("button", {
              class: "primary wide",
              type: "button",
              text: "Complete test payment",
              onClick: async (event) => {
                event.target.disabled = true;
                try {
                  await api(`/api/payments/simulate/${order.id}`, { method: "POST" });
                  refresh();
                } catch (error) {
                  alert(error.message);
                  event.target.disabled = false;
                }
              },
            }),
          ])
        : null,

      el("section", { class: "panel" }, [
        el("h2", { text: "Your order" }),
        ...order.lines.map((line) =>
          el("div", { class: "summary-line" }, [
            el("span", { text: `${line.quantity}× ${line.name}` }),
            el("span", { text: line.lineTotal }),
          ]),
        ),
        el("div", { class: "summary-total" }, [
          el("span", { text: "Total" }),
          el("span", { text: order.total }),
        ]),
      ]),

      el("button", { class: "secondary wide", type: "button", text: "Start a new order", onClick: () => navigate("/") }),
    );
  };

  const refresh = async () => {
    const { order } = await api(`/api/orders/${orderId}`);
    draw(order);
    if (order.paymentStatus === "paid" || order.paymentStatus === "failed") {
      clearInterval(pollTimer);
    }
    return order;
  };

  try {
    const order = await refresh();
    // Payment settles on a webhook, which lands whenever the provider sends it.
    if (order.paymentStatus === "pending") {
      pollTimer = setInterval(() => refresh().catch(() => {}), 3000);
    }
  } catch (error) {
    view.replaceChildren(el("p", { class: "empty", text: error.message }));
  }
}

function statusLabel(status) {
  return { pending: "Awaiting payment", paid: "Paid", failed: "Payment failed", expired: "Payment expired" }[status] ?? status;
}

// ------------------------------------------------ simulated checkout page

async function renderSimulatedCheckout() {
  cartToggle.hidden = true;
  const params = new URLSearchParams(location.search);
  const orderId = params.get("orderId");

  const { order } = await api(`/api/orders/${orderId}`);

  view.replaceChildren(
    el("section", { class: "panel" }, [
      el("div", { class: "notice", text: "Test mode. This stands in for the provider's payment page — no money moves." }),
      el("h2", { text: `Pay ${order.total}` }),
      el("p", { class: "muted", text: `Order ${order.reference} · ${params.get("provider")?.replace("_", " ")}` }),
      el("button", {
        class: "primary wide",
        type: "button",
        style: "margin-top:16px",
        text: "Approve payment",
        onClick: async (event) => {
          event.target.disabled = true;
          try {
            await api(`/api/payments/simulate/${orderId}`, { method: "POST" });
            navigate(`/order/${orderId}`);
          } catch (error) {
            alert(error.message);
            event.target.disabled = false;
          }
        },
      }),
      el("button", {
        class: "secondary wide",
        type: "button",
        style: "margin-top:10px",
        text: "Cancel",
        onClick: () => navigate(`/order/${orderId}`),
      }),
    ]),
  );
}

// ------------------------------------------------------------------ router

function navigate(path) {
  history.pushState({}, "", path);
  route();
}

async function route() {
  clearInterval(pollTimer);
  cartToggle.hidden = false;
  view.replaceChildren(el("p", { class: "loading", text: "Loading…" }));

  try {
    const path = location.pathname;
    if (path === "/simulated-checkout") await renderSimulatedCheckout();
    else if (path.startsWith("/order/")) await renderOrderView(path.split("/")[2]);
    else if (path === "/checkout") await renderCheckoutView();
    else await renderMenuView();
  } catch (error) {
    view.replaceChildren(el("p", { class: "empty", text: error.message }));
  }
}

cartToggle.addEventListener("click", openCart);
cartClose.addEventListener("click", closeCart);
scrim.addEventListener("click", closeCart);
checkoutButton.addEventListener("click", () => navigate("/checkout"));
window.addEventListener("popstate", route);

route();
