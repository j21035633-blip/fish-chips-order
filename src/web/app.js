// Customer order app. No framework, no build step — this page is opened by
// scanning a QR code at the table, so it should load on a bad connection.
//
// The menu cards and the option groups come from ./menu-browse.js, shared with
// the staff takeaway panel so both tap the same UI rather than two copies of it.

import {
  el,
  formatSen,
  itemDetails,
  menuSections,
  optionGroup,
  pricedSelection,
  selectedChoices as choicesIn,
} from "./menu-browse.js";

const view = document.getElementById("view");
const cartPanel = document.getElementById("cart-panel");
const cartBody = document.getElementById("cart-body");
const cartTotalEl = document.getElementById("cart-total");
const cartSubtotalEl = document.getElementById("cart-subtotal");
const cartTaxEl = document.getElementById("cart-tax");
const cartTaxLabelEl = document.getElementById("cart-tax-label");
const cartCountEl = document.getElementById("cart-count");
const cartBar = document.getElementById("cart-bar");
const cartBarTotal = document.getElementById("cart-bar-total");
const cartGrip = document.getElementById("cart-grip");
const cartClose = document.getElementById("cart-close");
const checkoutButton = document.getElementById("checkout-button");
const scrim = document.getElementById("scrim");
const itemDialog = document.getElementById("item-dialog");
const itemDialogBody = document.getElementById("item-dialog-body");
const itemTitle = document.getElementById("item-title");
const itemGrip = document.getElementById("item-grip");
const itemClose = document.getElementById("item-close");
const itemViewCart = document.getElementById("item-view-cart");
const itemQtyEl = document.getElementById("item-qty");
const itemPriceEl = document.getElementById("item-price");
const itemAddButton = document.getElementById("item-add");
const tableBadge = document.getElementById("table-badge");

const CART_KEY = "fishchips.cartId";
// The table survives checkout: the customer is still sitting there, so a second
// order in the same session goes to the same table without another scan.
const TABLE_KEY = "fishchips.tableNumber";

const state = {
  menu: null,
  cart: null,
  tableNumber: null,
  dialogItem: null,
  dialogQty: 1,
  pendingOrder: null,
  /**
   * Whether this view has a cart to show at all.
   *
   * The order and checkout pages are about one order that is already placed, so
   * a bar offering to edit a different one would be nonsense. Separate from
   * "the cart has items in it": both have to be true before anything is drawn.
   */
  cartVisible: true,
};

// ---------------------------------------------------------------- utilities

/**
 * Replaces a node's children.
 *
 * `Node.replaceChildren` stringifies anything that is not a Node, so a `null`
 * from a `cond ? el(...) : null` slot lands in the page as the literal text
 * "null". Drop the empty slots the way `el` already does for its own children.
 */
function mount(node, ...children) {
  node.replaceChildren(...children.filter((child) => child !== null && child !== undefined && child !== false));
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

/**
 * "Tax (10%)". The rate comes back with the cart rather than being written in
 * here, so it is stated in exactly one place — the server's.
 */
function taxLabel(priced) {
  const rate = priced?.taxRate;
  return rate === undefined ? "Tax" : `Tax (${Number((rate * 100).toFixed(2))}%)`;
}

/**
 * Subtotal, tax and total as three rows, for any view that sums an order up.
 *
 * One builder, so the checkout page and the receipt cannot end up showing the
 * breakdown differently from each other or from the cart sheet.
 */
function totalLines(priced) {
  return [
    el("div", { class: "summary-line" }, [
      el("span", { class: "muted", text: "Subtotal" }),
      el("span", { text: priced.subtotal }),
    ]),
    el("div", { class: "summary-line" }, [
      el("span", { class: "muted", text: taxLabel(priced) }),
      el("span", { text: priced.tax }),
    ]),
    el("div", { class: "summary-total" }, [
      el("span", { text: "Total" }),
      el("span", { text: priced.total }),
    ]),
  ];
}

// -------------------------------------------------------------------- cart

async function ensureCart() {
  const stored = localStorage.getItem(CART_KEY);
  if (stored) {
    try {
      const { cart } = await api(`/api/carts/${stored}`);
      setTable(cart.tableNumber ?? null);
      state.cart = cart;
      return cart;
    } catch (error) {
      // A restarted server drops in-memory carts; quietly start a new one.
      if (error.status !== 404) console.warn(error);
    }
  }
  return startFreshCart(localStorage.getItem(TABLE_KEY));
}

/**
 * Opens a brand-new cart, discarding whatever was stored.
 *
 * The table is a property of the *new* cart rather than something looked up
 * later, so a cart is routable from the moment it exists.
 */
async function startFreshCart(table) {
  localStorage.removeItem(CART_KEY);
  const { cartId, tableNumber } = await api("/api/carts", {
    method: "POST",
    body: JSON.stringify(table ? { table } : {}),
  });
  localStorage.setItem(CART_KEY, cartId);
  setTable(tableNumber ?? null);

  const { cart } = await api(`/api/carts/${cartId}`);
  state.cart = cart;
  renderCart();
  return cart;
}

function setTable(tableNumber) {
  state.tableNumber = tableNumber;
  if (tableNumber) localStorage.setItem(TABLE_KEY, tableNumber);
  else localStorage.removeItem(TABLE_KEY);
  tableBadge.textContent = tableNumber ? `Table ${tableNumber}` : "";
  tableBadge.hidden = !tableNumber;
}

function setCart(cart) {
  state.cart = cart;
  renderCart();
}

function renderCart() {
  const cart = state.cart;
  const lines = cart?.lines ?? [];
  const total = cart?.total ?? "RM0.00";
  const count = cart?.itemCount ?? 0;

  cartCountEl.textContent = String(count);
  cartTotalEl.textContent = total;
  cartBarTotal.textContent = total;
  // The bar shows the total, which includes tax; the breakdown that explains it
  // is one tap away in the sheet.
  cartSubtotalEl.textContent = cart?.subtotal ?? "RM0.00";
  cartTaxEl.textContent = cart?.tax ?? "RM0.00";
  cartTaxLabelEl.textContent = taxLabel(cart);
  checkoutButton.disabled = lines.length === 0;

  // Only offered from the options sheet when there is an order to go back to.
  itemViewCart.hidden = count === 0;
  itemViewCart.textContent = `View cart (${count} ${count === 1 ? "item" : "items"})`;

  // Nothing in the cart, nothing on screen: no bar, no sheet, and no reserved
  // strip at the bottom of the menu either. An order the customer emptied from
  // inside the sheet takes the sheet down with it — there is nothing left in
  // there to look at.
  const showBar = state.cartVisible && lines.length > 0;
  cartBar.hidden = !showBar;
  document.body.classList.toggle("has-cart", showBar);
  if (!showBar) closeCart();

  mount(cartBody,
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

/**
 * Set while the cart sheet was opened *from* the options sheet, which is put
 * away for the duration and brought back when the cart closes.
 *
 * A <dialog> opened with showModal() sits in the browser's top layer, above
 * every z-index on the page, so the cart could not be drawn over it — and
 * stacking a second dialog would mean two ways of opening the cart. Standing
 * the options sheet down instead costs nothing, because `close()` leaves its
 * DOM exactly as it was: the ice level stays checked and the quantity stays
 * put, so there is no state to save and restore and nothing to get wrong.
 */
let itemSheetStoodDown = false;

/**
 * Shows or hides the whole cart affordance for a view.
 *
 * Called by every route, so a view never has to remember to put it back.
 */
function setCartVisible(visible) {
  state.cartVisible = visible;
  if (!visible) {
    // Leaving the menu entirely. Whatever was half-chosen goes with it, rather
    // than reappearing over the checkout page.
    itemSheetStoodDown = false;
    dismissItem();
    closeCart();
  }
  renderCart();
}

function openCart() {
  // Only ever from a tap, and only when there is something to show. The panel
  // opening by itself was the bug: an empty sheet over the menu, on load,
  // before the customer had done anything at all.
  if (cartBar.hidden) return;

  cartPanel.hidden = false;
  scrim.hidden = false;
  cartBar.setAttribute("aria-expanded", "true");
  document.body.classList.add("cart-open");
  cartClose.focus();
}

function closeCart() {
  cartPanel.hidden = true;
  scrim.hidden = true;
  cartPanel.style.removeProperty("--sheet-drag");
  cartPanel.classList.remove("dragging");
  cartBar.setAttribute("aria-expanded", "false");
  document.body.classList.remove("cart-open");

  // Back to what they were in the middle of choosing, untouched.
  if (itemSheetStoodDown) {
    itemSheetStoodDown = false;
    itemDialog.showModal();
  }
}

/**
 * Swipe a sheet down to dismiss it.
 *
 * Shared by the cart and the item options: one gesture, wired once, so a
 * customer who learns it on one sheet has learnt it on the other.
 *
 * Only from the grip. A drag that started on the scrolling content would have
 * to guess whether the customer meant to scroll or dismiss, and guessing wrong
 * loses their place. Pointer events rather than touch events, so a mouse drag
 * behaves the same and there is one code path.
 */
function trackSheetDrag(sheet, grip, dismiss) {
  const DISMISS_PX = 90;
  let startY = null;

  grip.addEventListener("pointerdown", (event) => {
    startY = event.clientY;
    try {
      // Keeps the gesture on the grip if the finger wanders off it. Throws on a
      // pointer id that is no longer active, which is not worth losing the drag
      // over — the move and up handlers work without capture.
      grip.setPointerCapture(event.pointerId);
    } catch {}
    sheet.classList.add("dragging");
  });

  grip.addEventListener("pointermove", (event) => {
    if (startY === null) return;
    // Downward only. Dragging up would lift the sheet off the bottom edge and
    // show the page through the gap.
    const offset = Math.max(0, event.clientY - startY);
    sheet.style.setProperty("--sheet-drag", `${offset}px`);
  });

  const end = (event) => {
    if (startY === null) return;
    const offset = Math.max(0, event.clientY - startY);
    startY = null;
    sheet.classList.remove("dragging");
    sheet.style.removeProperty("--sheet-drag");
    if (offset > DISMISS_PX) dismiss();
  };

  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// -------------------------------------------------------------- menu view

async function renderMenuView() {
  const [{ categories }] = await Promise.all([api("/api/menu"), ensureCart()]);
  state.menu = categories;

  mount(view, ...menuSections(categories, openItem));

  renderCart();
}
// ------------------------------------------------------------ item dialog

function openItem(item) {
  state.dialogItem = item;
  state.dialogQty = 1;

  // The name lives in the sheet's head, beside the close button, so it stays on
  // screen while a long list of options scrolls under it.
  itemTitle.textContent = item.name;

  mount(itemDialogBody,
    ...itemDetails(item),
    ...item.optionGroups.map((group) => optionGroup(group, updateDialogPrice)),
  );

  itemQtyEl.textContent = "1";
  updateDialogPrice();
  itemDialog.showModal();
}

/**
 * Closes the options sheet without ordering anything.
 *
 * Every dismissal goes through here — the X, the backdrop, Escape and the
 * swipe — so there is one place where an abandoned selection is discarded.
 * Discarding is cheap: nothing is sent until Add is tapped, the options live in
 * the DOM that `openItem` rebuilds from scratch every time, and the quantity
 * goes back to 1 with it. Idempotent, so the native `cancel` firing alongside
 * our own Escape handling is not a problem.
 */
function dismissItem() {
  if (itemDialog.hasAttribute("open")) itemDialog.close();
  state.dialogItem = null;
  state.dialogQty = 1;
}

function updateDialogPrice() {
  // Nothing to price once the sheet has been dismissed; a late event from a
  // pointer that was mid-tap must not throw.
  if (!state.dialogItem) return;
  itemPriceEl.textContent = formatSen(pricedSelection(state.dialogItem, itemDialogBody, state.dialogQty));
}

itemClose.addEventListener("click", dismissItem);

/**
 * Straight to the order, and back again.
 *
 * `close()` rather than `dismissItem()` — deliberately not the dismiss path,
 * because nothing here is being abandoned: the selection has to be exactly
 * where it was left when the cart is closed again.
 */
itemViewCart.addEventListener("click", () => {
  if (itemViewCart.hidden) return;
  itemSheetStoodDown = true;
  itemDialog.close();
  openCart();
});

// The backdrop. A click that lands on the dialog element itself was outside the
// sheet, because the form fills it edge to edge — that is the standard way to
// tell "outside" from "inside" on a <dialog>, which has no separate scrim node.
itemDialog.addEventListener("click", (event) => {
  if (event.target === itemDialog) dismissItem();
});

// Escape. The browser already closes a modal dialog on it and fires `cancel`;
// this is where the abandoned selection gets dropped either way.
itemDialog.addEventListener("cancel", dismissItem);

trackSheetDrag(itemDialog, itemGrip, dismissItem);

itemDialog.addEventListener("click", (event) => {
  const step = event.target.closest("[data-qty]");
  if (!step) return;
  state.dialogQty = Math.min(20, Math.max(1, state.dialogQty + Number(step.dataset.qty)));
  itemQtyEl.textContent = String(state.dialogQty);
  updateDialogPrice();
});

itemAddButton.addEventListener("click", async () => {
  const selections = choicesIn(itemDialogBody).map(({ groupId, choiceId }) => ({ groupId, choiceId }));
  try {
    const { cart } = await api(`/api/carts/${state.cart.cartId}/lines`, {
      method: "POST",
      body: JSON.stringify({ itemId: state.dialogItem.id, quantity: state.dialogQty, selections }),
    });
    itemDialog.close();
    // Deliberately does *not* open the sheet. Adding an item used to throw the
    // full panel over the menu, which put a wall in front of someone who was
    // most likely about to add a second thing. The bar appearing with a new
    // count and total is the confirmation; the sheet waits to be asked for.
    setCart(cart);
  } catch (error) {
    alert(error.message);
  }
});

// --------------------------------------------------------- checkout view

/**
 * The radio list of payment methods, shared by checkout and the order page's
 * recovery panel so both submit the same `method` value.
 */
function methodPicker(methods) {
  return el(
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
  );
}

/** Starts a payment attempt for an order and returns what the adapter recorded. */
async function startPayment(orderId, method) {
  const { payment } = await api(`/api/orders/${orderId}/payment`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });
  return payment;
}

async function renderCheckoutView() {
  // The whole page is the order now, with its own total and pay button. A bar
  // over the top of it saying the same thing would just cover the button.
  setCartVisible(false);
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

  mount(view,
    el("h1", { style: "font-size:22px;margin-bottom:16px", text: "Checkout" }),

    el("section", { class: "panel" }, [
      el("h2", { text: "Your order" }),
      cart.tableNumber
        ? el("div", { class: "summary-line" }, [
            el("span", { class: "muted", text: "Table" }),
            el("span", { text: cart.tableNumber }),
          ])
        : null,
      ...cart.lines.map((line) =>
        el("div", { class: "summary-line" }, [
          el("span", { text: `${line.quantity}× ${line.name}` }),
          el("span", { text: line.lineTotal }),
        ]),
      ),
      // The same three lines as the cart sheet, and the same numbers: the Pay
      // button below charges `cart.total`, tax included.
      ...totalLines(cart),
    ]),

    el("section", { class: "panel" }, [
      el("label", { class: "field" }, [
        el("span", { text: "Name for pickup" }),
        el("input", { type: "text", id: "customer-name", placeholder: "e.g. Aisyah", maxlength: "60" }),
      ]),

      el("h2", { text: "How would you like to pay?" }),
      methodPicker(methods),
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

    const payment = await startPayment(order.id, method);

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
  // This order is placed; the cart it came from is gone. Takes the sheet down
  // with it if it happened to be open.
  setCartVisible(false);
  clearInterval(pollTimer);

  // Only fetched when an order turns out to have nowhere for the customer to pay.
  let methods = [];

  const draw = (order) => {
    const paid = order.paymentStatus === "paid";
    // Where the customer can actually go and pay, if anywhere. A provider that
    // accepts the session but answers with no link leaves an attempt on the
    // order that nobody can act on, which is indistinguishable from none.
    const payableUrl = order.payment?.checkoutUrl ?? order.payment?.qrCodeUrl;
    // Placing the order and starting the payment are two calls, so an order can
    // reach this page with no usable attempt on it. Offer a way to pay rather
    // than sitting on "waiting" forever.
    const stalled = !paid && !payableUrl;
    const errorEl = el("p", { class: "error", hidden: true });

    mount(view,
      el("section", { class: "panel", style: "text-align:center" }, [
        el("p", { class: "muted", text: "Order" }),
        el("div", { class: "reference", text: order.reference }),
        order.tableNumber
          ? el("p", { class: "muted", style: "margin:6px 0 0", text: `Table ${order.tableNumber}` })
          : null,
        el("div", { style: "margin-top:12px" }, [
          el("span", { class: `status ${order.paymentStatus}`, text: statusLabel(order.paymentStatus) }),
        ]),
        paid
          ? el("p", { style: "margin:16px 0 0", text: "Paid — we're on it. Show this screen at the counter." })
          : stalled
            ? el("p", { class: "muted", style: "margin:16px 0 0", text: stalledReason(order) })
            : el("p", { class: "muted", style: "margin:16px 0 0", text: "Waiting for payment to confirm…" }),
      ]),

      // A live link the customer can go back to — they may have closed the tab.
      !paid && payableUrl
        ? el("section", { class: "panel" }, [
            el("a", { class: "primary wide button-link", href: payableUrl, text: "Continue to payment" }),
          ])
        : null,

      stalled
        ? el("section", { class: "panel" }, [
            el("h2", { text: "How would you like to pay?" }),
            methodPicker(methods),
            el("button", {
              class: "primary wide",
              type: "button",
              style: "margin-top:16px",
              text: `Pay ${order.total}`,
              onClick: async (event) => {
                const button = event.target;
                const method = view.querySelector('input[name="method"]:checked')?.value;
                errorEl.hidden = true;
                button.disabled = true;
                button.textContent = "Starting payment…";
                try {
                  const payment = await startPayment(order.id, method);
                  if (payment?.checkoutUrl) {
                    window.location.href = payment.checkoutUrl;
                    return;
                  }
                  startPolling(await refresh());
                } catch (error) {
                  errorEl.textContent = error.message;
                  errorEl.hidden = false;
                  button.disabled = false;
                  button.textContent = `Pay ${order.total}`;
                }
              },
            }),
            errorEl,
          ])
        : null,

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
        // This is the receipt, so it shows what was charged and how it was
        // arrived at — from the order's own stored fields, not recomputed.
        ...totalLines(order),
      ]),

      el("button", { class: "secondary wide", type: "button", text: "Start a new order", onClick: () => navigate("/") }),
    );
  };

  const refresh = async () => {
    const { order } = await api(`/api/orders/${orderId}`);
    // Nothing else on this page needs the method list, so only pay for it when
    // the recovery panel is about to be drawn.
    const stuck = !order.payment?.checkoutUrl && !order.payment?.qrCodeUrl;
    if (stuck && order.paymentStatus === "pending" && methods.length === 0) {
      ({ methods } = await api("/api/payments/methods"));
    }
    draw(order);
    if (order.paymentStatus === "paid" || order.paymentStatus === "failed") {
      clearInterval(pollTimer);
    }
    return order;
  };

  const startPolling = (order) => {
    clearInterval(pollTimer);
    // Payment settles on a webhook, which lands whenever the provider sends it.
    // Only poll once an attempt exists — redrawing underneath the method picker
    // would throw away the customer's selection every three seconds.
    if (order.paymentStatus === "pending" && (order.payment?.checkoutUrl || order.payment?.qrCodeUrl)) {
      pollTimer = setInterval(() => refresh().catch(() => {}), 3000);
    }
  };

  try {
    startPolling(await refresh());
  } catch (error) {
    mount(view, el("p", { class: "empty", text: error.message }));
  }
}

/** Why the order is stuck, in the customer's terms. */
function stalledReason(order) {
  return order.payment
    ? "We couldn't get a payment page from the provider. Try again below."
    : "Payment hasn't been started for this order yet.";
}

function statusLabel(status) {
  return { pending: "Awaiting payment", paid: "Paid", failed: "Payment failed", expired: "Payment expired" }[status] ?? status;
}

// ------------------------------------------------ simulated checkout page

async function renderSimulatedCheckout() {
  setCartVisible(false);
  const params = new URLSearchParams(location.search);
  const orderId = params.get("orderId");

  const { order } = await api(`/api/orders/${orderId}`);

  mount(view,
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

// ---------------------------------------------------------- QR table landing

/**
 * Where a table's QR points: `/order?table=5`.
 *
 * A scan always opens a brand-new session. The previous customer's cart at this
 * table must never appear, so this discards the stored cart before asking for
 * one — the table is a routing tag, not a shared "current order".
 *
 * The URL is then rewritten to "/" so that a refresh resumes *this* customer's
 * cart rather than silently starting a third one. Only a real scan re-enters
 * here, which is exactly when a fresh cart is wanted.
 */
async function renderTableLanding() {
  const table = new URLSearchParams(location.search).get("table");

  if (table) {
    try {
      await startFreshCart(table);
    } catch (error) {
      // A malformed table in a mis-printed QR should not strand the customer at
      // a blank page; the counter flow still works.
      console.warn(error);
      mount(view, el("p", { class: "empty", text: `${error.message} Showing the menu instead.` }));
      history.replaceState({}, "", "/");
      setCartVisible(true);
      return;
    }
  }

  // No table: this is the counter/takeaway entry point, so keep whatever cart
  // the customer already had.
  history.replaceState({}, "", "/");
  await renderMenuView();
}

// ------------------------------------------------------------------ router

function navigate(path) {
  history.pushState({}, "", path);
  route();
}

async function route() {
  clearInterval(pollTimer);
  setCartVisible(true);
  mount(view, el("p", { class: "loading", text: "Loading…" }));

  try {
    const path = location.pathname;
    if (path === "/order") await renderTableLanding();
    else if (path === "/simulated-checkout") await renderSimulatedCheckout();
    else if (path.startsWith("/order/")) await renderOrderView(path.split("/")[2]);
    else if (path === "/checkout") await renderCheckoutView();
    else await renderMenuView();
  } catch (error) {
    mount(view, el("p", { class: "empty", text: error.message }));
  }
}

// Three ways out of the sheet, plus the swipe: the X, the dimmed background,
// and Escape. A sheet with one exit is a sheet someone gets stuck in.
cartBar.addEventListener("click", openCart);
cartClose.addEventListener("click", closeCart);
scrim.addEventListener("click", closeCart);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // The dialog is on top when it is open, so it gets the key first. In a real
  // browser its own `cancel` has already fired by now; this is what makes
  // Escape work where <dialog> is stubbed, and it is a no-op if it is not.
  if (itemDialog.hasAttribute("open")) dismissItem();
  else if (!cartPanel.hidden) closeCart();
});
trackSheetDrag(cartPanel, cartGrip, closeCart);
checkoutButton.addEventListener("click", () => navigate("/checkout"));
window.addEventListener("popstate", route);

route();
