// Small DOM helpers, the routes container ref, and the modal.

export const $ = (sel) => document.querySelector(sel);
export const routesArea = $("#routes-area");

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

export function input(value, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder || "";
  i.autocomplete = "off";
  return i;
}

export function iconBtn(label, title, cls) {
  const b = el("button", "icon-btn" + (cls ? ` ${cls}` : ""));
  b.textContent = label;
  b.title = title;
  b.type = "button";
  return b;
}

export function toast(msg) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = msg;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

export function renderSprite(box, url) {
  box.innerHTML = "";
  if (url) {
    box.classList.remove("empty");
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      box.classList.add("empty");
      img.remove();
    });
    box.appendChild(img);
  } else {
    box.classList.add("empty");
  }
}

// ---- Modal ----
let onCloseCb = null;
function escClose(e) {
  if (e.key === "Escape") closeModal();
}
export function closeModal() {
  document.querySelector(".modal-overlay")?.remove();
  document.removeEventListener("keydown", escClose);
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb(); // fires for every dismissal path (X, overlay, Escape)
}
export function openModal(contentNode, { onClose } = {}) {
  closeModal();
  onCloseCb = onClose || null;
  const overlay = el("div", "modal-overlay");
  const modal = el("div", "modal");
  const close = iconBtn("✕", "Close", "del");
  close.classList.add("modal-close");
  close.addEventListener("click", closeModal);
  modal.append(close, contentNode);
  overlay.appendChild(modal);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", escClose);
  return modal;
}

/** Designed replacement for window.confirm(); resolves true (confirmed) or
 *  false (cancelled / dismissed any other way). */
export function confirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const content = el("div", "confirm");
    const h = el("h3");
    h.textContent = title;
    const p = el("p", "confirm-msg");
    p.textContent = message;
    const actions = el("div", "confirm-actions");
    const cancel = el("button", "btn");
    cancel.type = "button";
    cancel.textContent = cancelLabel;
    const ok = el("button", "btn " + (danger ? "danger" : "primary"));
    ok.type = "button";
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    content.append(h, p, actions);

    cancel.addEventListener("click", closeModal); // → onClose → finish(false)
    ok.addEventListener("click", () => {
      finish(true);
      closeModal();
    });
    openModal(content, { onClose: () => finish(false) });
    ok.focus();
  });
}
