// ==UserScript==
// @name         Torn Faction Bankers 🪙 Clean
// @namespace    Fries91.Torn.FactionBankers.Clean
// @version      0.5.5
// @description  Faction vault request app with header coin alert and built-in faction page request bar.
// @author       Fries91
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      faction-bankers-request.onrender.com
// @connect      api.torn.com
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const BANKER_API_BASE = "https://faction-bankers-request.onrender.com";

  // Locked PDA/Torn header position for money / points / merits / gender row.
  // Increase LEFT to move right. Decrease LEFT to move left.
  // Increase TOP to move down. Decrease TOP to move up.
  const COIN_LOCK_LEFT = 172;
  const COIN_LOCK_TOP = 244;

  const K_API_KEY = "fb_api_key_v1";
  const K_OPEN = "fb_overlay_open_v1";
  const K_SEEN_PENDING = "fb_seen_pending_ids_v1";

  const APP = {
    me: null,
    requests: [],
    pendingCount: 0,
    busy: false,
    open: false,
    lastLoad: 0,
    booted: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function money(v) {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return "$0";
    return "$" + Math.floor(n).toLocaleString();
  }

  function isTornPage() {
    return location.hostname === "www.torn.com" || location.hostname === "torn.com";
  }

  function isFactionPage() {
    return location.href.includes("factions.php");
  }

  function gmRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: BANKER_API_BASE.replace(/\/$/, "") + path,
        headers: {
          "Content-Type": "application/json",
          "X-Torn-Key": GM_getValue(K_API_KEY, ""),
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 25000,
        onload: (res) => {
          let data = {};
          try {
            data = JSON.parse(res.responseText || "{}");
          } catch {
            data = { ok: false, error: res.responseText || "Bad JSON response" };
          }

          if (res.status >= 200 && res.status < 300) {
            resolve(data);
          } else {
            reject(new Error(data.error || `HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  function ensureStyles() {
    if ($("#fb-style")) return;

    const style = document.createElement("style");
    style.id = "fb-style";
    style.textContent = `
      #fb-bank-coin-clean {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 34px !important;
        height: 28px !important;
        margin-left: 6px !important;
        border: 1px solid rgba(255,255,255,.12) !important;
        border-radius: 9px !important;
        background: transparent !important;
        color: #ffd36a !important;
        font-size: 20px !important;
        line-height: 1 !important;
        cursor: pointer !important;
        user-select: none !important;
        position: relative !important;
        z-index: 20 !important;
        box-shadow: none !important;
      }

      #fb-bank-coin-clean.fb-fixed-test {
        position: fixed !important;
        right: 8px !important;
        bottom: 74px !important;
        z-index: 100000 !important;
        background: rgba(0,0,0,.55) !important;
      }

      #fb-bank-coin-clean.fb-fixed-header {
        position: relative !important;
        left: auto !important;
        top: auto !important;
        z-index: 20 !important;
      }

      .fb-coin-mount-row {
        display: flex !important;
        align-items: center !important;
        flex-wrap: nowrap !important;
        gap: 0 !important;
        position: relative !important;
      }

      #fb-bank-coin-clean:hover {
        opacity: .96 !important;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.85)) saturate(1) brightness(1.02) !important;
      }

      #fb-bank-coin-clean.fb-alert {
        opacity: 1 !important;
        background: radial-gradient(circle, rgba(220,0,0,.58), rgba(130,0,0,.24) 62%, transparent 72%) !important;
        border-radius: 50% !important;
        box-shadow: 0 0 8px rgba(255,0,0,.68) !important;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.9)) saturate(1.1) brightness(1.02) !important;
      }

      #fb-bank-coin-clean.fb-alert::after {
        content: attr(data-count);
        position: absolute;
        top: -5px;
        right: -6px;
        min-width: 13px;
        height: 13px;
        padding: 0 3px;
        border-radius: 999px;
        background: #ff3131;
        color: #fff;
        font-size: 8px;
        font-weight: 900;
        line-height: 13px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(0,0,0,.65);
      }

      #fb-built-in-box {
        width: calc(100% - 18px);
        box-sizing: border-box;
        margin: 8px auto 10px auto;
        padding: 8px;
        border-radius: 10px;
        border: 1px solid rgba(255, 211, 106, .35);
        background: linear-gradient(180deg, rgba(25,25,25,.96), rgba(8,8,8,.96));
        box-shadow: 0 4px 14px rgba(0,0,0,.45);
        color: #eee;
        position: relative;
        z-index: 15;
        font-family: Arial, Helvetica, sans-serif;
      }

      #fb-built-in-box.fb-built-alert {
        border-color: rgba(255,80,80,.95);
        box-shadow: 0 0 12px rgba(255,0,0,.45);
      }

      .fb-built-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 7px;
      }

      .fb-built-head b {
        display: block;
        color: #ffd36a;
        font-size: 13px;
        line-height: 1.1;
      }

      .fb-built-head span {
        display: block;
        color: #aaa;
        font-size: 10px;
        margin-top: 2px;
      }

      #fb-built-open {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.08);
        color: #fff;
        border-radius: 8px;
        padding: 5px 9px;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .fb-built-grid {
        display: grid;
        grid-template-columns: 1fr 1.2fr auto;
        gap: 6px;
      }

      #fb-built-amount,
      #fb-built-note {
        min-width: 0;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(0,0,0,.45);
        color: #fff;
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 12px;
        outline: none;
      }

      #fb-built-send {
        border: 1px solid rgba(255,211,106,.45);
        background: rgba(255,211,106,.16);
        color: #ffd36a;
        border-radius: 8px;
        padding: 7px 9px;
        font-size: 12px;
        font-weight: 900;
        cursor: pointer;
      }

      #fb-overlay {
        position: fixed;
        top: 74px;
        right: 12px;
        width: min(470px, calc(100vw - 18px));
        max-height: calc(100vh - 92px);
        overflow: hidden;
        display: none;
        flex-direction: column;
        background:
          radial-gradient(circle at top left, rgba(255,211,106,.18), transparent 34%),
          linear-gradient(180deg, #161616, #0d0d0d);
        border: 1px solid rgba(255,211,106,.32);
        border-radius: 16px;
        box-shadow: 0 18px 50px rgba(0,0,0,.62);
        color: #eee;
        z-index: 99999;
        font-family: Arial, Helvetica, sans-serif;
      }

      #fb-overlay.fb-show {
        display: flex;
      }

      #fb-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 12px;
        border-bottom: 1px solid rgba(255,255,255,.1);
        background: rgba(0,0,0,.22);
      }

      #fb-title strong {
        font-size: 15px;
        color: #ffd36a;
      }

      #fb-title span {
        display: block;
        font-size: 11px;
        color: #aaa;
        margin-top: 2px;
      }

      #fb-close {
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(255,255,255,.06);
        color: #fff;
        border-radius: 10px;
        padding: 6px 10px;
        cursor: pointer;
        font-weight: 900;
      }

      #fb-body {
        overflow: auto;
        padding: 12px;
      }

      .fb-box {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.045);
        border-radius: 14px;
        padding: 11px;
        margin-bottom: 10px;
      }

      .fb-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .fb-space {
        justify-content: space-between;
      }

      .fb-label {
        display: block;
        font-size: 11px;
        color: #aaa;
        margin-bottom: 4px;
      }

      .fb-input,
      .fb-textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px;
        background: rgba(0,0,0,.42);
        color: #fff;
        padding: 9px 10px;
        outline: none;
      }

      .fb-textarea {
        min-height: 66px;
        resize: vertical;
      }

      .fb-btn {
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.08);
        color: #fff;
        border-radius: 10px;
        padding: 8px 10px;
        cursor: pointer;
        font-weight: 800;
      }

      .fb-btn.gold {
        background: rgba(255,211,106,.16);
        border-color: rgba(255,211,106,.48);
        color: #ffd36a;
      }

      .fb-btn.green {
        background: rgba(22,145,72,.22);
        border-color: rgba(70,220,125,.45);
      }

      .fb-btn.red {
        background: rgba(165,35,35,.25);
        border-color: rgba(255,85,85,.45);
      }

      .fb-btn.blue {
        background: rgba(45,105,180,.24);
        border-color: rgba(110,170,255,.45);
      }

      .fb-btn.pay {
        background: rgba(255,211,106,.18);
        border-color: rgba(255,211,106,.52);
        color: #ffd36a;
        text-decoration: none;
      }

      .fb-tabs {
        display: flex;
        gap: 6px;
        padding: 8px 12px 0;
        flex-wrap: wrap;
      }

      .fb-tab {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.055);
        color: #ddd;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 900;
      }

      .fb-tab.active {
        color: #ffd36a;
        border-color: rgba(255,211,106,.45);
        background: rgba(255,211,106,.12);
      }

      .fb-pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.065);
        color: #ddd;
        font-size: 11px;
        font-weight: 800;
      }

      .fb-pill.pending {
        color: #ffd36a;
        border-color: rgba(255,211,106,.35);
      }

      .fb-pill.approved {
        color: #7dff9d;
        border-color: rgba(90,220,120,.35);
      }

      .fb-pill.denied {
        color: #ff8585;
        border-color: rgba(255,85,85,.35);
      }

      .fb-pill.paid {
        color: #92c8ff;
        border-color: rgba(120,180,255,.35);
      }

      .fb-small {
        font-size: 11px;
        color: #aaa;
      }

      .fb-muted {
        color: #aaa;
      }

      .fb-error {
        color: #ff8d8d;
        font-size: 12px;
        line-height: 1.35;
      }

      .fb-success {
        color: #8dffac;
        font-size: 12px;
        line-height: 1.35;
      }

      .fb-request-title {
        font-size: 13px;
        font-weight: 900;
        color: #fff;
      }

      .fb-request-meta {
        font-size: 11px;
        color: #aaa;
        margin-top: 3px;
      }

      .fb-request-note {
        margin-top: 8px;
        font-size: 12px;
        color: #ddd;
        line-height: 1.35;
        white-space: pre-wrap;
      }

      @media (max-width: 520px) {
        #fb-overlay {
          top: 62px;
          right: 6px;
          left: 6px;
          width: auto;
          max-height: calc(100vh - 72px);
          border-radius: 14px;
        }

        #fb-body {
          padding: 10px;
        }

        #fb-built-in-box {
          width: calc(100% - 8px);
          margin: 6px auto 8px auto;
          padding: 7px;
        }

        .fb-built-grid {
          grid-template-columns: 1fr;
        }

        #fb-built-amount,
        #fb-built-note,
        #fb-built-send {
          width: 100%;
          box-sizing: border-box;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getCleanText(el) {
    return String(el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function looksLikeMoneyPointsMeritsRow(el) {
    const text = getCleanText(el);
    const rect = el.getBoundingClientRect();
    const cls = String(el.className || "");

    if (!rect || rect.width < 250 || rect.height < 20 || rect.height > 48) return false;

    // From your debug:
    // #7: class swiperWrapper___sfn5X, text "Money:$2.7MPoints:17Merits:2"
    // #6: upper row has Energy/Nerve/Happy/Life/Chain.
    const hasMoneyWords = text.includes("Money:") && text.includes("Points:") && text.includes("Merits:");
    const hasMoneySymbols = text.includes("$") && (text.includes("P") || text.includes("Points")) && (text.includes("Merits") || text.includes("★") || text.includes("⭐"));

    const isKnownTornResourceClass =
      cls.includes("swiperWrapper") ||
      cls.includes("user-information-mobile") ||
      cls.includes("userInformation") ||
      cls.includes("user-info");

    return (hasMoneyWords || hasMoneySymbols) && (isKnownTornResourceClass || rect.top > 120);
  }

  function findTornResourceRow() {
    // First use the exact mobile resource row found by debug.
    const exact = Array.from(document.querySelectorAll("div")).find(looksLikeMoneyPointsMeritsRow);
    if (exact) return exact;

    // Then search all rows and score the money/points/merits row.
    const candidates = Array.from(document.querySelectorAll("div, ul, nav, section")).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 250 || rect.height < 20 || rect.height > 55) return false;

      const text = getCleanText(el);
      return text.includes("$") && (text.includes("Points") || /\bP\b/.test(text)) && (text.includes("Merits") || text.includes("★") || text.includes("⭐"));
    });

    if (candidates.length) {
      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const at = getCleanText(a);
        const bt = getCleanText(b);

        const aScore =
          (at.includes("Money:") ? 50 : 0) +
          (at.includes("Points:") ? 40 : 0) +
          (at.includes("Merits:") ? 40 : 0) +
          (String(a.className || "").includes("swiperWrapper") ? 30 : 0) -
          Math.abs(ar.height - 30);

        const bScore =
          (bt.includes("Money:") ? 50 : 0) +
          (bt.includes("Points:") ? 40 : 0) +
          (bt.includes("Merits:") ? 40 : 0) +
          (String(b.className || "").includes("swiperWrapper") ? 30 : 0) -
          Math.abs(br.height - 30);

        return bScore - aScore;
      });

      return candidates[0];
    }

    return null;
  }

  function findGenderInsertTarget(row) {
    if (!row) return null;

    const all = Array.from(row.querySelectorAll("a, div, span, li, i, img, button"));

    // Best: exact gender icon.
    let target = all.find((el) => {
      const text = getCleanText(el);
      const cls = String(el.className || "").toLowerCase();
      const title = String(el.getAttribute("title") || "").toLowerCase();
      const alt = String(el.getAttribute("alt") || "").toLowerCase();

      return text === "♂" || text === "♀" || cls.includes("gender") || title.includes("gender") || alt.includes("gender");
    });

    if (target) return target;

    // Fallback: find the merit/star icon, then coin goes after it, which is beside the gender area on PDA.
    target = all.find((el) => {
      const text = getCleanText(el);
      const cls = String(el.className || "").toLowerCase();
      const title = String(el.getAttribute("title") || "").toLowerCase();
      const alt = String(el.getAttribute("alt") || "").toLowerCase();

      return text.includes("★") || text.includes("⭐") || cls.includes("merit") || title.includes("merit") || alt.includes("merit");
    });

    if (target) return target;

    return null;
  }

  function mountCoin() {
    document.querySelectorAll("#fb-bank-coin").forEach((oldCoin) => {
      oldCoin.style.display = "none";
      oldCoin.remove();
    });

    let coin = $("#fb-bank-coin-clean");

    if (!coin) {
      coin = document.createElement("button");
      coin.id = "fb-bank-coin-clean";
      coin.type = "button";
      coin.title = "Faction Bankers";
      coin.textContent = "🪙";
      coin.setAttribute("data-count", "0");
      coin.addEventListener("click", openBankerBoard);
    }

    coin.classList.remove("fb-fixed-test", "fb-fixed-header");
    coin.classList.add("fb-gender-lock");

    const row = findTornResourceRow();

    if (row) {
      row.classList.add("fb-coin-mount-row");

      // Mount inside the real money/points/merits row, but lock it visually beside gender
      // instead of appending it to the far end of the row.
      if (coin.parentElement !== row) {
        row.appendChild(coin);
      }
    } else if (coin.parentElement !== document.body) {
      // Last-resort tiny fixed button so it never disappears during testing.
      coin.classList.remove("fb-gender-lock");
      coin.classList.add("fb-fixed-test");
      document.body.appendChild(coin);
    }
  }

  function findFactionBuiltInMount() {
    const exactFactionHeader = Array.from(document.querySelectorAll("div, h1, h2, h3, span"))
      .find((el) => String(el.textContent || "").trim().toLowerCase() === "faction");

    if (exactFactionHeader) {
      let p = exactFactionHeader.parentElement;
      for (let i = 0; i < 4 && p; i += 1) {
        if (p.offsetWidth > 250) return p;
        p = p.parentElement;
      }
    }

    const candidates = [
      ".faction-info-wrap",
      ".faction-info",
      ".faction-tabs",
      ".content-title",
      "#factions",
      ".factions-wrap",
      ".faction-page",
      ".content-wrapper",
      ".content",
      "main",
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    return document.body;
  }

  function mountBuiltInBankerBox() {
    if (!isFactionPage()) return;
    if ($("#fb-built-in-box")) return;

    const box = document.createElement("div");
    box.id = "fb-built-in-box";
    box.innerHTML = `
      <div class="fb-built-head">
        <div>
          <b>🪙 Faction Bankers</b>
          <span id="fb-built-status">Request faction vault money</span>
        </div>
        <button id="fb-built-open" type="button">Open</button>
      </div>

      <div class="fb-built-grid">
        <input id="fb-built-amount" inputmode="numeric" placeholder="Amount needed">
        <input id="fb-built-note" placeholder="Reason / note">
        <button id="fb-built-send" type="button">Request</button>
      </div>
    `;

    const tabBar =
      document.querySelector(".faction-tabs") ||
      document.querySelector("[class*='faction'] [class*='tabs']") ||
      document.querySelector("[class*='tabs']");

    if (tabBar && tabBar.parentElement) {
      tabBar.parentElement.insertBefore(box, tabBar.nextSibling);
    } else {
      const mount = findFactionBuiltInMount();

      const warBox = Array.from(mount.querySelectorAll("div")).find((el) =>
        String(el.textContent || "").toLowerCase().includes("your faction is not in a war")
      );

      if (warBox?.parentElement) {
        warBox.parentElement.insertBefore(box, warBox);
      } else {
        mount.insertBefore(box, mount.firstChild);
      }
    }

    $("#fb-built-open")?.addEventListener("click", openOverlay);
    $("#fb-built-send")?.addEventListener("click", submitBuiltInRequest);
  }

  function ensureOverlay() {
    if ($("#fb-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "fb-overlay";
    overlay.innerHTML = `
      <div id="fb-head">
        <div id="fb-title">
          <strong>🪙 Faction Bankers</strong>
          <span id="fb-subtitle">Faction vault request board</span>
        </div>
        <button id="fb-close" type="button">✕</button>
      </div>

      <div class="fb-tabs">
        <button class="fb-tab active" data-tab="request" type="button">Request</button>
        <button class="fb-tab" data-tab="my" type="button">My Requests</button>
        <button class="fb-tab" data-tab="banker" type="button">Banker</button>
        <button class="fb-tab" data-tab="settings" type="button">Settings</button>
      </div>

      <div id="fb-body"></div>
    `;

    document.body.appendChild(overlay);

    $("#fb-close").addEventListener("click", closeOverlay);

    $$(".fb-tab", overlay).forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".fb-tab", overlay).forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderBody(btn.dataset.tab);
      });
    });
  }

  function openOverlay() {
    APP.open = true;
    GM_setValue(K_OPEN, true);
    ensureOverlay();
    $("#fb-overlay").classList.add("fb-show");
    refreshAll(true);
  }

  function closeOverlay() {
    APP.open = false;
    GM_setValue(K_OPEN, false);
    const ov = $("#fb-overlay");
    if (ov) ov.classList.remove("fb-show");
  }

  function toggleOverlay() {
    const ov = $("#fb-overlay");
    if (ov && ov.classList.contains("fb-show")) closeOverlay();
    else openOverlay();
  }

  function openBankerBoard() {
    openOverlay();

    setTimeout(() => {
      const bankerTab = document.querySelector('.fb-tab[data-tab="banker"]');
      if (bankerTab) bankerTab.click();
    }, 150);
  }

  function activeTab() {
    const btn = $(".fb-tab.active");
    return btn?.dataset?.tab || "request";
  }

  function setCoinAlert(count) {
    const coin = $("#fb-bank-coin-clean");
    const n = Number(count || 0);
    const canBank = !!(APP.me?.is_banker || APP.me?.is_admin);
    APP.pendingCount = n;

    if (coin) {
      coin.setAttribute("data-count", String(n > 99 ? "99+" : n));

      if (canBank) {
        coin.classList.add("fb-banker-visible");
      } else {
        coin.classList.remove("fb-banker-visible");
      }

      if (canBank && n > 0) {
        coin.classList.add("fb-alert");
        coin.title = `${n} pending faction bank request${n === 1 ? "" : "s"} — tap to pay members`;
      } else {
        coin.classList.remove("fb-alert");
        coin.title = "Faction Bankers";
      }
    }

    const builtBox = $("#fb-built-in-box");
    if (builtBox) {
      if (canBank && n > 0) {
        builtBox.classList.add("fb-built-alert");
        const status = $("#fb-built-status");
        if (status) status.textContent = `${n} pending banker request${n === 1 ? "" : "s"}`;
      } else {
        builtBox.classList.remove("fb-built-alert");
      }
    }
  }

  function setBody(html) {
    const body = $("#fb-body");
    if (body) body.innerHTML = html;
  }

  function statusPill(status) {
    const s = String(status || "pending").toLowerCase();
    const label = {
      pending: "Pending",
      approved: "Approved",
      denied: "Denied",
      paid: "Complete",
      cancelled: "Cancelled",
    }[s] || s;

    return `<span class="fb-pill ${esc(s)}">${esc(label)}</span>`;
  }

  function renderBody(tab = activeTab()) {
    if (!GM_getValue(K_API_KEY, "")) {
      renderSettings("Add your Torn API key first.");
      return;
    }

    if (!APP.me) {
      setBody(`<div class="fb-box"><div class="fb-muted">Loading account...</div></div>`);
      return;
    }

    if (tab === "request") renderRequestTab();
    if (tab === "my") renderMyTab();
    if (tab === "banker") renderBankerTab();
    if (tab === "settings") renderSettings();
  }

  function renderRequestTab(msg = "") {
    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}

      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">Request money from faction bank</div>
            <div class="fb-small">Logged in as ${esc(APP.me?.name || "Unknown")} ${APP.me?.faction_name ? `• ${esc(APP.me.faction_name)}` : ""}</div>
          </div>
          <span class="fb-pill">Member</span>
        </div>
      </div>

      <div class="fb-box">
        <label class="fb-label">Amount requested</label>
        <input id="fb-amount" class="fb-input" inputmode="numeric" placeholder="Example: 25000000">

        <label class="fb-label" style="margin-top:10px;">Reason / note</label>
        <textarea id="fb-note" class="fb-textarea" placeholder="Example: Need vault money for war refill, armor buy, meds, etc."></textarea>

        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-submit-request" class="fb-btn gold" type="button">Send Request</button>
          <button id="fb-refresh" class="fb-btn" type="button">Refresh</button>
        </div>

        <div class="fb-small" style="margin-top:8px;">
          This sends a request to faction bankers. A banker still pays from the faction vault manually.
        </div>
      </div>
    `);

    $("#fb-submit-request")?.addEventListener("click", submitRequest);
    $("#fb-refresh")?.addEventListener("click", () => refreshAll(true));
  }

  function renderMyTab() {
    const mine = APP.requests.filter((r) => String(r.requester_id) === String(APP.me?.player_id));

    const cards = mine.length
      ? mine.map(requestCard).join("")
      : `<div class="fb-box"><div class="fb-muted">No requests yet.</div></div>`;

    setBody(`
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">My Requests</div>
            <div class="fb-small">Track your faction bank requests here.</div>
          </div>
          <button id="fb-refresh-my" class="fb-btn" type="button">Refresh</button>
        </div>
      </div>
      ${cards}
    `);

    $("#fb-refresh-my")?.addEventListener("click", () => refreshAll(true));
  }

  function renderBankerTab() {
    if (!APP.me?.is_banker) {
      setBody(`
        <div class="fb-box">
          <div class="fb-request-title">Banker Access</div>
          <div class="fb-error" style="margin-top:6px;">
            You are not listed as a banker for this app.
          </div>
          <div class="fb-small" style="margin-top:8px;">
            Banker access is controlled by the backend BANKER_IDS setting.
          </div>
        </div>
      `);
      return;
    }

    const pending = APP.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending");
    const others = APP.requests.filter((r) => String(r.status || "pending").toLowerCase() !== "pending");

    const cards = [
      pending.length
        ? `<div class="fb-box"><strong style="color:#ffd36a;">Pending Requests</strong></div>${pending.map(requestCard).join("")}`
        : `<div class="fb-box"><div class="fb-muted">No pending requests.</div></div>`,
      others.length
        ? `<div class="fb-box"><strong>Recent History</strong></div>${others.slice(0, 20).map(requestCard).join("")}`
        : "",
    ].join("");

    setBody(`
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">Banker Board</div>
            <div class="fb-small">${pending.length} pending request${pending.length === 1 ? "" : "s"}</div>
          </div>
          <button id="fb-refresh-banker" class="fb-btn" type="button">Refresh</button>
        </div>
      </div>
      ${cards}
    `);

    $("#fb-refresh-banker")?.addEventListener("click", () => refreshAll(true));

    $$("[data-fb-action]").forEach((btn) => {
      btn.addEventListener("click", () => bankerAction(btn.dataset.id, btn.dataset.fbAction));
    });
  }

  function requestCard(r) {
    const id = esc(r.id);
    const status = String(r.status || "pending").toLowerCase();
    const isBanker = !!APP.me?.is_banker;

    const created = r.created_at ? esc(r.created_at) : "";
    const requester = esc(r.requester_name || `User ${r.requester_id || ""}`);
    const handledBy = r.handled_by_name ? `<div class="fb-small">Handled by: ${esc(r.handled_by_name)}</div>` : "";

    let actions = "";

    if (isBanker && status === "pending") {
      actions = `
        <div class="fb-row" style="margin-top:10px;">
          <a class="fb-btn pay" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(String(r.requester_id || ""))}" target="_blank" rel="noopener">Open Member</a>
          <button class="fb-btn green" data-id="${id}" data-fb-action="approve" type="button">Approve</button>
          <button class="fb-btn blue" data-id="${id}" data-fb-action="paid" type="button">Mark Complete</button>
          <button class="fb-btn red" data-id="${id}" data-fb-action="deny" type="button">Deny</button>
        </div>
      `;
    }

    if (isBanker && status === "approved") {
      actions = `
        <div class="fb-row" style="margin-top:10px;">
          <a class="fb-btn pay" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(String(r.requester_id || ""))}" target="_blank" rel="noopener">Open Member</a>
          <button class="fb-btn blue" data-id="${id}" data-fb-action="paid" type="button">Mark Complete</button>
          <button class="fb-btn red" data-id="${id}" data-fb-action="deny" type="button">Deny</button>
        </div>
      `;
    }

    return `
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">${requester} requested ${money(r.amount)}</div>
            <div class="fb-request-meta">Request #${id}${created ? ` • ${created}` : ""}</div>
          </div>
          ${statusPill(status)}
        </div>

        ${r.note ? `<div class="fb-request-note">${esc(r.note)}</div>` : `<div class="fb-request-note fb-muted">No note added.</div>`}

        ${handledBy}
        ${r.bank_note ? `<div class="fb-small">Bank note: ${esc(r.bank_note)}</div>` : ""}

        ${actions}
      </div>
    `;
  }

  function renderSettings(msg = "") {
    const key = GM_getValue(K_API_KEY, "");

    setBody(`
      ${msg ? `<div class="fb-box"><div class="fb-error">${esc(msg)}</div></div>` : ""}

      <div class="fb-box">
        <div class="fb-request-title">Settings</div>
        <div class="fb-small" style="margin-top:4px;">
          Save your Torn API key so the banker app can verify your faction and account.
        </div>
      </div>

      <div class="fb-box">
        <label class="fb-label">Torn API key</label>
        <input id="fb-api-key" class="fb-input" value="${esc(key)}" placeholder="Paste Torn API key">

        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-save-key" class="fb-btn gold" type="button">Save Key</button>
          <button id="fb-test-login" class="fb-btn" type="button">Test Login</button>
          <button id="fb-enable-notify" class="fb-btn blue" type="button">Enable In-App Ping</button>
        </div>
      </div>

      <div class="fb-box">
        <div class="fb-small">
          Backend URL:
          <br>
          <span style="color:#ffd36a;">${esc(BANKER_API_BASE)}</span>
        </div>
      </div>
    `);

    $("#fb-save-key")?.addEventListener("click", () => {
      const keyInput = $("#fb-api-key")?.value?.trim() || "";
      GM_setValue(K_API_KEY, keyInput);
      renderSettings("Saved. Tap Test Login.");
    });

    $("#fb-test-login")?.addEventListener("click", () => refreshAll(true));
    $("#fb-enable-notify")?.addEventListener("click", requestNotifyPermission);
  }

  async function submitBuiltInRequest() {
    if (APP.busy) return;

    const amountRaw = ($("#fb-built-amount")?.value || "").replace(/[^\d]/g, "");
    const amount = Number(amountRaw);
    const note = $("#fb-built-note")?.value?.trim() || "";
    const status = $("#fb-built-status");

    if (!GM_getValue(K_API_KEY, "")) {
      if (status) status.textContent = "Save your API key in settings first";
      openOverlay();
      return;
    }

    if (!amount || amount < 1) {
      if (status) status.textContent = "Enter a valid amount";
      return;
    }

    APP.busy = true;
    if (status) status.textContent = "Sending request...";

    try {
      await gmRequest("POST", "/api/banker/requests", { amount, note });
      $("#fb-built-amount").value = "";
      $("#fb-built-note").value = "";
      if (status) status.textContent = "Request sent to bankers";
      await refreshAll(true);
    } catch (err) {
      if (status) status.textContent = err.message || "Request failed";
    } finally {
      APP.busy = false;
    }
  }

  async function submitRequest() {
    if (APP.busy) return;

    const amountRaw = ($("#fb-amount")?.value || "").replace(/[^\d]/g, "");
    const amount = Number(amountRaw);
    const note = $("#fb-note")?.value?.trim() || "";

    if (!amount || amount < 1) {
      renderRequestTab(`<div class="fb-error">Enter a valid amount.</div>`);
      return;
    }

    APP.busy = true;
    renderRequestTab(`<div class="fb-muted">Sending request...</div>`);

    try {
      await gmRequest("POST", "/api/banker/requests", { amount, note });
      await refreshAll(true);
      renderRequestTab(`<div class="fb-success">Request sent to faction bankers.</div>`);
    } catch (err) {
      renderRequestTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
    } finally {
      APP.busy = false;
    }
  }

  async function bankerAction(id, action) {
    if (APP.busy || !id || !action) return;

    const note = action === "deny"
      ? prompt("Reason for denying request?") || ""
      : "";

    APP.busy = true;

    try {
      await gmRequest("POST", `/api/banker/requests/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
        note,
      });
      await refreshAll(true);
      renderBankerTab();
    } catch (err) {
      setBody(`
        <div class="fb-box">
          <div class="fb-error">${esc(err.message || err)}</div>
        </div>
      `);
    } finally {
      APP.busy = false;
    }
  }


  function getSeenPendingIds() {
    try {
      const raw = GM_getValue(K_SEEN_PENDING, "[]");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  function saveSeenPendingIds(ids) {
    GM_setValue(K_SEEN_PENDING, JSON.stringify(Array.from(new Set(ids.map(String))).slice(-100)));
  }

  function requestNotifyPermission() {
    if (!("Notification" in window)) {
      GM_setValue("fb_in_app_ping_enabled_v1", true);
      alert("PDA/browser notifications are not supported here. In-app banker ping is enabled instead: the 🪙 coin and banker box will turn red when requests are pending.");
      return;
    }

    Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        GM_setValue("fb_in_app_ping_enabled_v1", true);
        alert("Banker notifications enabled.");
      } else {
        GM_setValue("fb_in_app_ping_enabled_v1", true);
        alert("Browser notifications were not allowed. In-app banker ping is enabled instead: the 🪙 coin and banker box will turn red when requests are pending.");
      }
    });
  }

  function notifyBankerForNewPending(pendingItems) {
    if (!APP.me?.is_banker && !APP.me?.is_admin) return;

    const seen = getSeenPendingIds();
    const seenSet = new Set(seen);
    const fresh = pendingItems.filter((r) => !seenSet.has(String(r.id)));

    if (!fresh.length) return;

    // PDA-friendly in-app ping: vibrate where supported, while the red coin/request box is the visual ping.
    try {
      if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
    } catch {
      // Ignore vibration errors.
    }

    if ("Notification" in window && Notification.permission === "granted") {
      for (const req of fresh.slice(0, 3)) {
        const title = "🪙 New Faction Bank Request";
        const body = `${req.requester_name || "Member"} requested ${money(req.amount)}${req.note ? " — " + req.note : ""}`;

        try {
          const n = new Notification(title, {
            body,
            tag: `faction-bank-request-${req.id}`,
            silent: false,
          });

          n.onclick = () => {
            window.focus();
            openBankerBoard();
          };
        } catch {
          // Ignore notification errors.
        }
      }
    }

    saveSeenPendingIds([...seen, ...fresh.map((r) => String(r.id))]);
  }

  async function refreshAll(force = false) {
    const key = GM_getValue(K_API_KEY, "");
    if (!key) {
      setCoinAlert(0);
      if (APP.open) renderSettings("Add your Torn API key first.");
      return;
    }

    if (!force && Date.now() - APP.lastLoad < 12000) return;

    APP.lastLoad = Date.now();

    try {
      const me = await gmRequest("GET", "/api/banker/me");
      APP.me = me;

      const list = await gmRequest("GET", "/api/banker/requests");
      APP.requests = Array.isArray(list.items) ? list.items : [];

      const pendingItems = APP.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending");
      const pending = pendingItems.length;

      setCoinAlert(pending);
      notifyBankerForNewPending(pendingItems);

      if (APP.open) renderBody(activeTab());
    } catch (err) {
      setCoinAlert(0);

      if (APP.open) {
        setBody(`
          <div class="fb-box">
            <div class="fb-error">${esc(err.message || err)}</div>
            <div class="fb-small" style="margin-top:8px;">
              Check your API key and backend URL.
            </div>
          </div>
        `);
      }
    }
  }

  function boot() {
    if (!isTornPage()) return;

    ensureStyles();
    mountCoin();
    mountBuiltInBankerBox();
    ensureOverlay();

    APP.booted = true;

    if (GM_getValue(K_OPEN, false)) openOverlay();

    setTimeout(() => refreshAll(true), 1800);

    setInterval(() => {
      mountCoin();
      mountBuiltInBankerBox();

      if (GM_getValue(K_API_KEY, "")) {
        refreshAll(false);
      }
    }, 15000);
  }

  function startWhenReady() {
    if (!isTornPage()) return;

    boot();

    const obs = new MutationObserver(() => {
      if (!isTornPage()) return;
      ensureStyles();
      mountCoin();
      mountBuiltInBankerBox();
      ensureOverlay();
    });

    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWhenReady, { once: true });
  } else {
    startWhenReady();
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      setTimeout(() => {
        if (isTornPage()) {
          mountCoin();
          mountBuiltInBankerBox();
          refreshAll(true);
        }
      }, 800);
    }
  }, 1000);
})();
