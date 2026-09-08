import { el } from "./common.js";

/**
 * "Who is taking this payment?" — the per-transaction staff check.
 *
 * The shared password says somebody behind the counter did it. This says which
 * of them, and the answer is stamped onto the order. It is deliberately *not* a
 * login: no session comes out of it, nothing is remembered between transactions,
 * and the password on the account is not asked for.
 *
 * **Why a sheet rather than two fields on the order card.** Both boards redraw
 * from the poll every two seconds. Inline inputs would be rebuilt underneath
 * whoever was typing into them — the value gone, the caret gone, every couple of
 * seconds. The sheet lives outside the polled region, so what is typed survives
 * until it is submitted, and a rejection has somewhere to be read.
 *
 * Nothing is prefilled, on purpose. A remembered id one tap from Confirm is
 * exactly the hole this closes: the next person to walk up to the tablet would
 * be attributing their transactions to whoever used it last.
 */

let sheet = null;

/** Builds the sheet once per page and hands back the controls over it. */
function mount() {
  if (sheet) return sheet;

  const staffId = el("input", {
    id: "attribution-id",
    class: "attribution-input",
    type: "text",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    maxlength: "12",
    placeholder: "e.g. AR47",
  });
  const staffName = el("input", {
    id: "attribution-name",
    class: "attribution-input",
    type: "text",
    autocomplete: "off",
    maxlength: "60",
    placeholder: "Full name",
  });

  const title = el("h2", { id: "attribution-title", text: "Who is taking this?" });
  const detail = el("p", { class: "attribution-detail" });
  const error = el("p", { class: "form-error", hidden: true });
  const confirm = el("button", { class: "advance wide", type: "button", text: "Confirm" });
  const cancel = el("button", { class: "ghost wide", type: "button", text: "Cancel" });

  const dialog = el("dialog", { class: "attribution-dialog", "aria-labelledby": "attribution-title" }, [
    el("div", { class: "sheet-head" }, [title, el("span", {})]),
    el("div", { class: "attribution-body" }, [
      detail,
      el("label", { class: "field", for: "attribution-id" }, [el("span", { text: "Staff ID" }), staffId]),
      el("label", { class: "field", for: "attribution-name" }, [el("span", { text: "Name" }), staffName]),
      error,
      confirm,
      cancel,
    ]),
  ]);

  document.body.append(dialog);
  sheet = { dialog, title, detail, error, staffId, staffName, confirm, cancel };
  return sheet;
}

/**
 * Asks who is doing this, then runs `onConfirm` with the pair they typed.
 *
 * `onConfirm` is the real action — settling, or ringing up a takeaway — and it
 * is what actually verifies the pair, server-side, as part of doing the thing.
 * There is no separate "check this id" call: a check that passed a moment before
 * the action is not the same as an action that was authorised, and the endpoints
 * refuse an unverified pair anyway.
 *
 * A thrown error is shown in the sheet and the sheet stays open, so a mistyped
 * name is one correction away rather than a dismissed dialog and a lost tap.
 *
 * Resolves true when the action went through, false when it was cancelled.
 */
export function askStaff({ title, detail, onConfirm }) {
  const ui = mount();

  ui.title.textContent = title ?? "Who is taking this?";
  ui.detail.textContent = detail ?? "";
  ui.detail.hidden = !detail;
  ui.error.hidden = true;
  ui.staffId.value = "";
  ui.staffName.value = "";
  ui.confirm.disabled = false;

  return new Promise((resolve) => {
    const finish = (result) => {
      ui.confirm.removeEventListener("click", submit);
      ui.cancel.removeEventListener("click", dismiss);
      ui.dialog.removeEventListener("cancel", dismiss);
      ui.dialog.close();
      resolve(result);
    };

    const dismiss = () => finish(false);

    async function submit() {
      const staffId = ui.staffId.value.trim();
      const staffName = ui.staffName.value.trim();
      if (staffId.length === 0 || staffName.length === 0) {
        ui.error.textContent = "Enter both the staff ID and the name.";
        ui.error.hidden = false;
        return;
      }

      ui.confirm.disabled = true;
      ui.error.hidden = true;
      try {
        await onConfirm({ staffId, staffName });
        finish(true);
      } catch (error) {
        // The server's own words: it is the one that knows whether the id is
        // unknown, the account is off, or the name does not match it.
        ui.error.textContent = error.message;
        ui.error.hidden = false;
        ui.confirm.disabled = false;
      }
    }

    ui.confirm.addEventListener("click", submit);
    ui.cancel.addEventListener("click", dismiss);
    // Escape, which a <dialog> fires as `cancel`.
    ui.dialog.addEventListener("cancel", dismiss);

    ui.dialog.showModal();
    ui.staffId.focus();
  });
}

/**
 * "Settled by: Aisyah Rahman", on every board the order appears on.
 *
 * Says "Settled" only when the money is actually in: a card takeaway is handled
 * by the person who rang it up long before the webhook makes it paid, and
 * claiming otherwise on the board would be the one place this system tells the
 * counter something untrue about money.
 */
export function processedByLine(order) {
  if (!order.processedBy?.name) return null;

  const verb = order.paymentStatus === "paid" ? "Settled by" : "Handled by";
  return el("div", { class: "processed-by" }, [
    el("span", { class: "processed-by-label", text: `${verb}: ` }),
    el("span", { class: "processed-by-name", text: order.processedBy.name }),
  ]);
}

/** Test seam: the sheet is mounted once per document, and jsdom reuses one. */
export function resetStaffPrompt() {
  sheet?.dialog.remove();
  sheet = null;
}
