// ==UserScript==
// @name         Torn Faction Bankers 🪙 
// @namespace    Fries91.Torn.FactionBankers.
// @version      1.0.8
// @description  Faction vault request app with coin-only launcher and faction dropdown.
// @author       Fries91
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @updateURL    https://faction-bankers-request.onrender.com/static/faction-bankers.user.js
// @downloadURL  https://faction-bankers-request.onrender.com/static/faction-bankers.user.js
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
  const FB_BUILD = "1.0.8-header-coin-tabs";

  // Locked PDA/Torn header position for money / points / merits / gender row.
  // Increase LEFT to move right. Decrease LEFT to move left.
  // Increase TOP to move down. Decrease TOP to move up.
  const COIN_LOCK_LEFT = 172;
  const COIN_LOCK_TOP = 244;

  const K_API_KEY = "fb_api_key_v1";
  const K_OPEN = "fb_overlay_open_v1";
  const K_SEEN_PENDING = "fb_seen_pending_ids_v1";
  const K_TARGET_FACTION = "fb_target_faction_v1";
  const K_PAY_PREFILL = "fb_pay_prefill_v1";
  const K_SCROLL_TO_BANK = "fb_scroll_to_bank_box_v1";
  const FULL_BALANCE_NOTE = "__FULL_BALANCE_REQUEST__";
  const K_BALANCE_CAPTURE = "fb_balance_capture_pending_v1";
  const K_MANUAL_BALANCE_AMOUNT = "fb_manual_personal_balance_amount_v1";
  const K_MANUAL_BALANCE_TEXT = "fb_manual_personal_balance_text_v1";

  // Dynamic role mode: no hard-coded faction list.
  // The backend uses the logged-in player's own faction and finds bankers by faction role.
  const DEFAULT_FACTIONS = [];

  const APP = {
    me: null,
    factions: DEFAULT_FACTIONS.slice(),
    requests: [],
    bankers: [],
    manualBankers: [],
    leaderRoleNames: [],
    defaultRoleNames: [],
    leaderLoadError: "",
    bankerFactionId: "",
    bankerStatusError: "",
    balanceAmount: null,
    balanceText: "Balance unavailable",
    balanceSource: "",
    balanceUpdatedAt: 0,
    pendingCount: 0,
    busy: false,
    open: false,
    lastLoad: 0,
    booted: false,
    refreshing: false,
    lastBuiltSig: "",
    lastMountRun: 0,
    lastProfileMountRun: 0,
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

  function isOwnFactionPage() {
    if (!isFactionPage()) return false;

    const url = new URL(location.href);
    const params = url.searchParams;

    // Other faction pages normally have an ID/XID or profile/view style step.
    if (params.has("ID") || params.has("id") || params.has("XID") || params.has("xid")) return false;

    const step = String(params.get("step") || "").toLowerCase();
    const type = String(params.get("type") || "").toLowerCase();

    if (step.includes("profile")) return false;
    if (step.includes("view")) return false;
    if (type.includes("profile")) return false;

    return true;
  }

  function isProfilePage() {
    return location.href.includes("profiles.php") || location.href.includes("/profiles.php");
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
        timeout: 45000,
        onload: (res) => {
          let data = {};
          try {
            data = JSON.parse(res.responseText || "{}");
          } catch {
            const raw = String(res.responseText || "");
            const clean = raw
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160);
            data = { ok: false, error: (res.status >= 500 ? "Render backend 500. Replace/redeploy app.py or check DATABASE_URL. Details: " : "") + (clean || "Render returned a non-JSON error. Check app.py deploy logs.") };
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
        width: 30px !important;
        height: 30px !important;
        min-width: 30px !important;
        margin: 0 4px !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 6px !important;
        background: transparent !important;
        color: #ffd36a !important;
        font-size: 19px !important;
        line-height: 1 !important;
        cursor: pointer !important;
        user-select: none !important;
        position: relative !important;
        z-index: 40 !important;
        box-shadow: none !important;
        vertical-align: middle !important;
        -webkit-appearance: none !important;
        appearance: none !important;
      }

      #fb-bank-coin-clean.fb-fixed-test {
        display: none !important;
      }

            #fb-bank-coin-clean.fb-fixed-header {
        display: inline-flex !important;
        position: relative !important;
        left: auto !important;
        top: auto !important;
        z-index: 40 !important;
        flex: 0 0 auto !important;
        vertical-align: middle !important;
      }

      #fb-bank-coin-clean.fb-header-fallback {
        display: none !important;
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
        background: rgba(170,0,0,.28) !important;
        border-radius: 7px !important;
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

      #fb-profile-bank-coin {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 28px !important;
        height: 28px !important;
        min-width: 28px !important;
        margin: 0 4px !important;
        border: 1px solid rgba(255,211,106,.55) !important;
        border-radius: 8px !important;
        background: rgba(0,0,0,.45) !important;
        color: #ffd36a !important;
        font-size: 17px !important;
        line-height: 1 !important;
        cursor: pointer !important;
        box-shadow: 0 2px 8px rgba(0,0,0,.38) !important;
        vertical-align: middle !important;
        position: relative !important;
        z-index: 30 !important;
      }

      #fb-profile-bank-coin:hover {
        border-color: rgba(255,211,106,.9) !important;
        filter: brightness(1.08) !important;
      }

      #fb-profile-bank-coin.fb-profile-fallback {
        display: none !important;
      }

      .fb-bsp-coin-slot {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-left: 4px !important;
        vertical-align: middle !important;
      }

      #fb-built-in-box {
        width: calc(100% - 14px) !important;
        max-width: 680px !important;
        box-sizing: border-box !important;
        margin: 7px auto 9px auto !important;
        padding: 7px 8px !important;
        border-radius: 12px !important;
        border: 1px solid rgba(255, 211, 106, .40) !important;
        background: linear-gradient(180deg, rgba(20,20,20,.97), rgba(7,7,7,.97)) !important;
        box-shadow: 0 4px 14px rgba(0,0,0,.48) !important;
        color: #eee !important;
        position: relative !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        z-index: 15 !important;
        font-family: Arial, Helvetica, sans-serif !important;
        clear: both !important;
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
        margin-bottom: 6px;
      }

      .fb-built-head b {
        display: block;
        color: #ffd36a;
        font-size: 12px;
        line-height: 1.1;
        letter-spacing: .2px;
      }

      .fb-built-head span {
        display: block;
        color: #aaa;
        font-size: 10px;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 72vw;
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
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        align-items: center;
      }

      #fb-built-bankers {
        grid-column: 1 / -1;
      }

      .fb-balance-line {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border: 1px solid rgba(255,211,106,.22);
        background: rgba(255,211,106,.075);
        color: #eee;
        border-radius: 9px;
        padding: 7px 8px;
        font-size: 12px;
        line-height: 1.2;
      }

      .fb-balance-line b {
        color: #ffd36a;
      }

      .fb-balance-line span {
        color: #aaa;
        font-size: 10px;
        white-space: nowrap;
      }

      #fb-built-amount,
      #fb-built-faction,
      #fb-built-banker,
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

      #fb-built-open-balance,
      #fb-built-refresh-balance,
      #fb-built-manual-balance {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.07);
        color: #ddd;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }


      #fb-built-open-balance {
        border-color: rgba(110,170,255,.55);
        background: rgba(45,105,180,.28);
        color: #e0efff;
      }

      #fb-built-manual-balance {
        border-color: rgba(255,211,106,.48);
        background: rgba(255,211,106,.16);
        color: #ffe39a;
      }

      #fb-built-full,
      #fb-full-request {
        border: 1px solid rgba(110,170,255,.45);
        background: rgba(45,105,180,.24);
        color: #d8eaff;
        border-radius: 8px;
        padding: 7px 9px;
        font-size: 12px;
        font-weight: 900;
        cursor: pointer;
      }


      #fb-setup-button {
        position: fixed !important;
        right: 10px !important;
        bottom: 86px !important;
        z-index: 100000 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        padding: 7px 10px !important;
        border: 1px solid rgba(255,211,106,.45) !important;
        border-radius: 999px !important;
        background: rgba(20,20,20,.88) !important;
        color: #ffd36a !important;
        font-size: 12px !important;
        font-weight: 900 !important;
        box-shadow: 0 6px 18px rgba(0,0,0,.55) !important;
        cursor: pointer !important;
      }

      #fb-setup-button.fb-hide {
        display: none !important;
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
        z-index: 100000;
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
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 7px;
        padding: 10px 12px 0;
      }

      .fb-tab {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.055);
        color: #ddd;
        border-radius: 999px;
        padding: 8px 8px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 900;
        min-height: 36px;
        white-space: nowrap;
        text-align: center;
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

      .fb-pay-notice {
        position: fixed;
        left: 8px;
        right: 8px;
        bottom: 12px;
        z-index: 100002;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid rgba(255,211,106,.55);
        background: rgba(10,10,10,.94);
        color: #ffd36a;
        font-size: 12px;
        font-weight: 900;
        text-align: center;
        box-shadow: 0 8px 24px rgba(0,0,0,.55);
      }


      .fb-bankers-list {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin-top: 8px;
      }

      #fb-built-bankers .fb-bankers-list {
        display: flex;
        gap: 5px;
        margin-top: 0;
        overflow-x: auto;
        padding-bottom: 1px;
        -webkit-overflow-scrolling: touch;
      }

      #fb-built-bankers .fb-banker-line {
        min-width: 116px;
        max-width: 156px;
        padding: 5px 6px;
        border-radius: 9px;
        flex: 0 0 auto;
      }

      #fb-built-bankers .fb-banker-line .fb-pill,
      #fb-built-bankers .fb-banker-line .fb-small + .fb-small {
        display: none;
      }

      #fb-built-bankers .fb-banker-main .fb-small {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 10px;
      }

      .fb-banker-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(0,0,0,.24);
      }

      .fb-banker-main {
        min-width: 0;
      }

      .fb-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        display: inline-block;
        margin-right: 6px;
        background: #888;
        box-shadow: 0 0 6px rgba(255,255,255,.25);
      }

      .fb-dot.green { background: #36d86f; box-shadow: 0 0 8px rgba(54,216,111,.75); }
      .fb-dot.orange { background: #ffac38; box-shadow: 0 0 8px rgba(255,172,56,.65); }
      .fb-dot.yellow { background: #ffd33d; box-shadow: 0 0 8px rgba(255,211,61,.65); }
      .fb-dot.blue { background: #55a9ff; box-shadow: 0 0 8px rgba(85,169,255,.65); }
      .fb-dot.red { background: #ff4d4d; box-shadow: 0 0 8px rgba(255,77,77,.65); }
      .fb-dot.gray { background: #8b8b8b; }

      .fb-banker-select {
        margin-top: 8px;
      }



      /* v1.0.6 polished vault theme */
      #fb-overlay,
      #fb-built-in-box {
        --fb-gold: #ffd36a;
        --fb-gold-soft: rgba(255,211,106,.14);
        --fb-safe: #72ff9f;
        --fb-blue: #9bd1ff;
        --fb-red: #ff7d7d;
        --fb-card: rgba(18,18,18,.86);
        --fb-card2: rgba(0,0,0,.34);
      }

      #fb-overlay {
        background:
          radial-gradient(circle at 12% 0%, rgba(255,211,106,.22), transparent 30%),
          radial-gradient(circle at 90% 8%, rgba(65,120,180,.13), transparent 30%),
          linear-gradient(180deg, #15120b, #090909 62%, #060606) !important;
        border-color: rgba(255,211,106,.42) !important;
      }

      #fb-title strong,
      .fb-request-title {
        letter-spacing: .2px;
      }

      .fb-box {
        background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025)) !important;
        border-color: rgba(255,255,255,.13) !important;
      }

      .fb-hero-card {
        border: 1px solid rgba(255,211,106,.34) !important;
        background:
          radial-gradient(circle at top left, rgba(255,211,106,.16), transparent 42%),
          linear-gradient(180deg, rgba(22,19,12,.95), rgba(7,7,7,.95)) !important;
      }

      .fb-flow-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .fb-flow-card {
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        padding: 9px;
        background: rgba(0,0,0,.22);
      }

      .fb-flow-card b {
        display: block;
        color: var(--fb-gold);
        font-size: 12px;
        margin-bottom: 3px;
      }

      .fb-flow-card span {
        display: block;
        color: #bbb;
        font-size: 11px;
        line-height: 1.35;
      }

      .fb-login-status {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 9px 10px;
        border-radius: 12px;
        border: 1px solid rgba(114,255,159,.35);
        background: rgba(30,130,75,.12);
      }

      .fb-login-status.off {
        border-color: rgba(255,125,125,.35);
        background: rgba(140,30,30,.12);
      }

      .fb-status-dot {
        display: inline-flex;
        width: 9px;
        height: 9px;
        border-radius: 999px;
        margin-right: 6px;
        background: #999;
        box-shadow: 0 0 6px currentColor;
      }

      .fb-status-dot.ok { background: #46e67d; color: #46e67d; }
      .fb-status-dot.warn { background: #ffd36a; color: #ffd36a; }
      .fb-status-dot.bad { background: #ff5757; color: #ff5757; }

      .fb-legal-list {
        margin: 8px 0 0 0;
        padding-left: 18px;
        color: #cfcfcf;
        font-size: 11px;
        line-height: 1.38;
      }

      .fb-legal-list li { margin: 4px 0; }

      .fb-mini-note {
        color: #aaa;
        font-size: 10px;
        line-height: 1.35;
        margin-top: 6px;
      }

      .fb-leader-current {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .fb-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      .fb-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.15);
        background: rgba(255,255,255,.06);
        color: #ddd;
        padding: 5px 8px;
        font-size: 11px;
        font-weight: 800;
      }

      @media (max-width: 520px) {
        .fb-flow-grid { grid-template-columns: 1fr; }
      }

      @media (max-width: 520px) {
  
      #fb-setup-button {
        position: fixed !important;
        right: 10px !important;
        bottom: 86px !important;
        z-index: 100000 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        padding: 7px 10px !important;
        border: 1px solid rgba(255,211,106,.45) !important;
        border-radius: 999px !important;
        background: rgba(20,20,20,.88) !important;
        color: #ffd36a !important;
        font-size: 12px !important;
        font-weight: 900 !important;
        box-shadow: 0 6px 18px rgba(0,0,0,.55) !important;
        cursor: pointer !important;
      }

      #fb-setup-button.fb-hide {
        display: none !important;
      }

      #fb-overlay {
          top: auto;
          right: 6px;
          left: 6px;
          bottom: calc(8px + env(safe-area-inset-bottom, 0px));
          width: auto;
          max-height: min(56vh, 430px);
          border-radius: 14px;
        }

        #fb-head {
          padding: 8px 10px;
        }

        #fb-title strong {
          font-size: 13px;
        }

        #fb-title span {
          font-size: 10px;
        }

        .fb-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 7px;
          padding: 8px 8px 0;
          overflow: visible;
        }

        .fb-tab {
          padding: 8px 6px;
          font-size: 11px;
          min-height: 36px;
          width: 100%;
        }

        #fb-body {
          padding: 8px;
          max-height: calc(min(56vh, 430px) - 86px);
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }

        .fb-box {
          padding: 8px;
          margin-bottom: 7px;
          border-radius: 11px;
        }

        #fb-profile-bank-coin {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 28px !important;
        height: 28px !important;
        min-width: 28px !important;
        margin: 0 4px !important;
        border: 1px solid rgba(255,211,106,.55) !important;
        border-radius: 8px !important;
        background: rgba(0,0,0,.45) !important;
        color: #ffd36a !important;
        font-size: 17px !important;
        line-height: 1 !important;
        cursor: pointer !important;
        box-shadow: 0 2px 8px rgba(0,0,0,.38) !important;
        vertical-align: middle !important;
        position: relative !important;
        z-index: 30 !important;
      }

      #fb-profile-bank-coin:hover {
        border-color: rgba(255,211,106,.9) !important;
        filter: brightness(1.08) !important;
      }

      #fb-profile-bank-coin.fb-profile-fallback {
        display: none !important;
      }

      .fb-bsp-coin-slot {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-left: 4px !important;
        vertical-align: middle !important;
      }

      #fb-built-in-box {
          width: calc(100% - 8px);
          margin: 6px auto 8px auto;
          padding: 7px;
        }

        .fb-built-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        align-items: center;
      }

      #fb-built-bankers {
        grid-column: 1 / -1;
      }

      .fb-balance-line {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border: 1px solid rgba(255,211,106,.22);
        background: rgba(255,211,106,.075);
        color: #eee;
        border-radius: 9px;
        padding: 7px 8px;
        font-size: 12px;
        line-height: 1.2;
      }

      .fb-balance-line b {
        color: #ffd36a;
      }

      .fb-balance-line span {
        color: #aaa;
        font-size: 10px;
        white-space: nowrap;
      }

        #fb-built-amount,
        #fb-built-faction,
        #fb-built-banker,
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


  function visibleRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 4 || r.height < 4) return null;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return null;
    return r;
  }

  function isIconLikeNode(el) {
    const r = visibleRect(el);
    if (!r) return false;
    if (r.width > 74 || r.height > 74 || r.width < 12 || r.height < 12) return false;

    const text = getCleanText(el);
    // Icon nodes usually have no text, one symbol, or a tiny label. Avoid full buttons/inputs.
    if (text.length > 18) return false;
    if (/bank|request|factional/i.test(text)) return false;

    const tag = String(el.tagName || "").toLowerCase();
    const cls = String(el.className || "").toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const hasVisualIcon = !!el.querySelector("img, svg, i") || tag === "img" || tag === "svg" || cls.includes("icon") || cls.includes("link") || role === "button";
    const likelyClickable = tag === "a" || tag === "button" || el.onclick || role === "button";

    return hasVisualIcon || likelyClickable || text.length <= 3;
  }

  function findCompactHeaderIconCluster() {
    // Desktop/iPhone full-site fallback: find the real Torn header icon strip and insert beside those icons.
    // This prevents the coin from floating on the right side when the mobile money/points row is not present.
    const parents = Array.from(document.querySelectorAll("header, nav, div, ul"));
    const scored = [];

    for (const parent of parents) {
      if (parent.id === "fb-overlay" || parent.closest("#fb-overlay") || parent.closest("#fb-built-in-box")) continue;
      const pr = visibleRect(parent);
      if (!pr) continue;

      const cls = String(parent.className || "").toLowerCase();
      const id = String(parent.id || "").toLowerCase();
      const nearTop = pr.top >= 0 && pr.top < Math.max(190, window.innerHeight * 0.22);
      const headerish = /header|top|menu|nav|icon|toolbar/.test(cls + " " + id);
      if (!nearTop && !headerish) continue;
      if (pr.width < 110 || pr.height < 18 || pr.height > 95) continue;

      const children = Array.from(parent.children || []).filter(isIconLikeNode);
      const nestedIcons = Array.from(parent.querySelectorAll(":scope > a, :scope > button, :scope > div, :scope > span, :scope > li")).filter(isIconLikeNode);
      const icons = children.length >= nestedIcons.length ? children : nestedIcons;
      if (icons.length < 3) continue;

      const textLen = getCleanText(parent).length;
      if (textLen > 180) continue;

      const last = icons[icons.length - 1];
      const lr = visibleRect(last);
      if (!lr) continue;

      const score =
        icons.length * 30 +
        (nearTop ? 80 : 0) +
        (headerish ? 60 : 0) +
        (pr.right > window.innerWidth * 0.5 ? 35 : 0) -
        Math.abs(pr.height - 38) -
        Math.max(0, textLen - 45);

      scored.push({ parent, target: last, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
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

  function scrollToFactionBankingBox() {
    const box = document.querySelector("#fb-built-in-box");
    if (!box) return false;

    try {
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      box.classList.add("fb-built-alert");
      setTimeout(() => box.classList.remove("fb-built-alert"), 1600);
    } catch {
      box.scrollIntoView();
    }
    return true;
  }

  function goToFactionBankingPage() {
    GM_setValue(K_SCROLL_TO_BANK, true);

    const ownFaction = isOwnFactionPage();
    if (!ownFaction) {
      const base = location.hostname === "torn.com" ? "https://torn.com" : "https://www.torn.com";
      window.location.href = `${base}/factions.php?step=your`;
      return;
    }

    pageMount("header-coin-click");
    if (!scrollToFactionBankingBox()) {
      setTimeout(() => {
        pageMount("header-coin-click-retry");
        scrollToFactionBankingBox();
      }, 700);
    }
  }

  function maybeScrollToBankingBox() {
    if (!GM_getValue(K_SCROLL_TO_BANK, false)) return;
    if (!isOwnFactionPage()) return;
    if (scrollToFactionBankingBox()) GM_setValue(K_SCROLL_TO_BANK, false);
  }

  function openHeaderCoinBoard() {
    goToFactionBankingPage();
  }

  function makeHeaderCoin() {
    let coin = $("#fb-bank-coin-clean");

    if (!coin) {
      coin = document.createElement("button");
      coin.id = "fb-bank-coin-clean";
      coin.type = "button";
      coin.title = "Factional Banking";
      coin.textContent = "🪙";
      coin.setAttribute("data-count", "0");
      coin.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openHeaderCoinBoard();
      });
    }

    return coin;
  }

  function mountCoin() {
    if (!isTornPage()) return;

    // Header-only coin. No profile coin, no floating fallback, no random page placement.
    const coin = makeHeaderCoin();
    coin.classList.remove("fb-fixed-test", "fb-header-fallback");
    coin.classList.add("fb-fixed-header", "fb-banker-visible");

    const row = findTornResourceRow();
    const target = row ? findGenderInsertTarget(row) : null;

    if (target && target.parentElement) {
      const parent = target.parentElement;
      if (coin.parentElement !== parent || coin.previousElementSibling !== target) {
        target.insertAdjacentElement("afterend", coin);
      }
      setCoinAlert(APP.pendingCount || 0);
      return;
    }

    if (row) {
      if (coin.parentElement !== row) row.appendChild(coin);
      setCoinAlert(APP.pendingCount || 0);
      return;
    }

    const cluster = findCompactHeaderIconCluster();
    if (cluster && cluster.target && cluster.target.parentElement) {
      if (coin.parentElement !== cluster.target.parentElement || coin.previousElementSibling !== cluster.target) {
        cluster.target.insertAdjacentElement("afterend", coin);
      }
      setCoinAlert(APP.pendingCount || 0);
      return;
    }

    // If Torn's header/icon row is not found, remove the coin instead of floating it on the page.
    if (coin.parentElement) coin.remove();
  }

  function findFactionBuiltInMount() {
    if (!isOwnFactionPage()) return null;

    // Strict PDA placement: only mount after the real faction icon/control row.
    // Do NOT fallback to <main> or body, because that puts the box in Home/header area.
    const all = Array.from(document.querySelectorAll("div, section, article, ul, nav"));

    const factionHeaders = Array.from(document.querySelectorAll("div, h1, h2, h3, span, strong"))
      .filter((el) => {
        const txt = getCleanText(el).toLowerCase();
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 40 || rect.height < 14) return false;
        if (rect.top < 250) return false;
        return txt === "faction";
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    const headerTop = factionHeaders.length ? factionHeaders[0].getBoundingClientRect().top : 0;

    const iconRows = all.filter((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 280 || rect.height < 35 || rect.height > 95) return false;
      if (headerTop && (rect.top < headerTop + 20 || rect.top > headerTop + 230)) return false;
      if (!headerTop && rect.top < 300) return false;

      const kids = Array.from(el.children || []);
      const iconishKids = kids.filter((k) => {
        const r = k.getBoundingClientRect();
        if (!r) return false;
        return r.width >= 28 && r.width <= 120 && r.height >= 28 && r.height <= 95;
      }).length;

      const txt = getCleanText(el).toLowerCase();
      const hay = [txt, el.className, el.id].map((v) => String(v || "").toLowerCase()).join(" ");

      // The Torn faction controls row has many equal-size icon buttons, often near a gear/gun/share/trophy row.
      return iconishKids >= 5 || hay.includes("controls") || hay.includes("faction-menu") || hay.includes("factiontabs");
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    const row = iconRows[0];
    if (row && row.parentElement) {
      return {
        parent: row.parentElement,
        after: row,
        mode: "strict-after-faction-icons",
      };
    }

    return null;
  }

  function profileIconHay(el) {
    return [
      el?.textContent,
      el?.getAttribute?.("title"),
      el?.getAttribute?.("alt"),
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("href"),
      el?.getAttribute?.("src"),
      el?.id,
      el?.className,
    ].map((v) => String(v || "").toLowerCase()).join(" ");
  }

  function looksLikeBspIcon(el) {
    if (!el || el.id === "fb-profile-bank-coin" || el.closest?.("#fb-profile-bank-coin")) return false;
    const hay = profileIconHay(el);
    return (
      hay.includes("absp") ||
      hay.includes("bsp") ||
      hay.includes("battle stat") ||
      hay.includes("battle-stats") ||
      hay.includes("battlestat") ||
      hay.includes("stat predictor") ||
      hay.includes("stat-predictor") ||
      hay.includes("battle stats") ||
      hay.includes("bs-predict") ||
      hay.includes("tornstats")
    );
  }

  function findAbspProfileIconTarget() {
    if (!isProfilePage()) return null;

    const nodes = Array.from(document.querySelectorAll("a, button, div, span, img, i, svg"));

    // Best: real ABSP/BSP icon by title/class/href/src/text.
    const exact = nodes.find(looksLikeBspIcon);
    if (exact) return { target: exact, exact: true };

    // Good fallback: on profile pages, many helper scripts create a compact icon cluster near the profile header.
    // Pick a compact visible icon inside the profile header area and place our coin beside it.
    const headerSelectors = [
      ".profile-wrapper",
      ".profile-container",
      ".profile-info",
      ".profile-header",
      ".basic-information",
      ".profile-name",
      ".content-title",
      "main",
    ];

    for (const sel of headerSelectors) {
      const root = document.querySelector(sel);
      if (!root) continue;

      const icons = Array.from(root.querySelectorAll("a, button, img, span, div")).filter((el) => {
        if (el.id === "fb-profile-bank-coin") return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 16 || rect.width > 70 || rect.height < 16 || rect.height > 70) return false;
        if (rect.top < 60 || rect.top > 420) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || 1) === 0) return false;
        return true;
      });

      if (icons.length) {
        icons.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.top - br.top) || (br.left - ar.left);
        });
        return { target: icons[0], exact: false };
      }
    }

    // Do not use a fixed floating fallback on profile pages; the user wants it beside BSP/ABSP only.
    return null;
  }

  function mountProfileBankCoin() {
    // Disabled by request: the coin must only live in Torn's header now.
    const coin = document.querySelector("#fb-profile-bank-coin");
    if (coin) coin.remove();
  }

  function mountBuiltInBankerBox() {
    detectFactionBalanceFromPage();
    const oldBox = $("#fb-built-in-box");

    // Only show the quick request box on your own faction page.
    // Keep it off profiles/other faction pages so it does not clutter the rest of Torn.
    if (!isOwnFactionPage()) {
      if (oldBox) oldBox.remove();
      return;
    }

    const mountInfo = findFactionBuiltInMount();
    const mount = mountInfo?.parent || mountInfo;
    if (!mount || !document.body.contains(mount)) {
      // PDA can briefly hide/rebuild the faction icon row while scrolling or refreshing.
      // If our box is already mounted, keep it instead of removing it and making it disappear.
      if (oldBox && document.body.contains(oldBox)) return;
      return;
    }

    let box = oldBox;
    const selectedFaction = APP.me?.faction_id || GM_getValue(K_TARGET_FACTION, "");
    const activeEl = document.activeElement;
    const userIsTyping = !!(box && activeEl && box.contains(activeEl) && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(activeEl.tagName));
    const renderSig = JSON.stringify({
      f: (APP.factions || []).map((x) => [String(x.faction_id || ""), String(x.faction_name || "")]),
      b: (APP.bankers || []).map((x) => [String(x.player_id || ""), String(x.name || ""), String(x.bucket || x.status_color || x.color || ""), String(x.status_text || x.status || x.label || "")]),
      err: APP.bankerStatusError || "",
      sf: selectedFaction,
      bal: String(APP.balanceAmount ?? APP.balanceText ?? ""),
    });

    if (!box) {
      box = document.createElement("div");
      box.id = "fb-built-in-box";
      box.setAttribute("data-fb-built", "1");
    } else if (box.dataset.sig === renderSig || userIsTyping) {
      // PDA-safe: do not rebuild while the user is tapping/typing.
      // Rebuilding the DOM during Torn/PDA mutations was causing freezes and blocked clicks.
      if (mountInfo?.after && document.body.contains(mountInfo.after) && box.previousElementSibling !== mountInfo.after) {
        mountInfo.after.insertAdjacentElement("afterend", box);
      }
      return;
    }

    box.dataset.sig = renderSig;
    box.innerHTML = `
      <div class="fb-built-head">
        <div>
          <b>🪙 Factional Banking</b>
          <span id="fb-built-status">Choose faction, banker, amount — send.</span>
        </div>
        <button id="fb-built-open" type="button">Board</button>
      </div>

      <div class="fb-built-grid">
        <div class="fb-own-faction">Faction: <b>${esc(APP.me?.faction_name || factionLabelById(selectedFaction) || "Your faction")}</b></div>
        ${balanceLineHtml()}
        <div class="fb-row" style="gap:6px; margin:0;">
          <button id="fb-built-open-balance" type="button">Sync Balance</button>
          <button id="fb-built-refresh-balance" type="button">Refresh</button>
          <button id="fb-built-manual-balance" type="button">Enter Manually</button>
        </div>
        <input id="fb-built-faction" type="hidden" value="${esc(selectedFaction)}">
        <select id="fb-built-banker" aria-label="Choose available banker">
          ${bankerOptions($("#fb-built-banker")?.value || "")}
        </select>
        <div id="fb-built-bankers">${bankerStatusPanel()}</div>
        <input id="fb-built-amount" inputmode="numeric" placeholder="Amount, example: 25000000">
        <button id="fb-built-send" type="button">Send Request</button>
        <button id="fb-built-full" type="button">Request Full Balance</button>
      </div>
    `;

    // Put the request box under the faction icon controls and above the faction panels.
    if (mountInfo?.before && document.body.contains(mountInfo.before)) {
      if (box.parentElement !== mount || box.nextElementSibling !== mountInfo.before) {
        mount.insertBefore(box, mountInfo.before);
      }
    } else if (mountInfo?.after && document.body.contains(mountInfo.after)) {
      if (box.parentElement !== mount || box.previousElementSibling !== mountInfo.after) {
        mountInfo.after.insertAdjacentElement("afterend", box);
      }
    } else if (box.parentElement !== mount) {
      if (mountInfo?.prepend && mount.prepend) mount.prepend(box);
      else mount.appendChild(box);
    }

    $("#fb-built-open")?.addEventListener("click", openOverlay);
    $("#fb-built-open-balance")?.addEventListener("click", openBalancePageForCapture);
    $("#fb-built-refresh-balance")?.addEventListener("click", async () => {
      if (!detectFactionBalanceFromPage()) {
        setFactionBalance(null, "", "Tap Sync Balance or Enter Manually");
      }
      await loadFactionBalance(true);
      mountBuiltInBankerBox();
    });
    $("#fb-built-manual-balance")?.addEventListener("click", promptManualBalance);
    $("#fb-built-send")?.addEventListener("click", submitBuiltInRequest);
    $("#fb-built-full")?.addEventListener("click", submitFullBalanceRequest);

    setCoinAlert(APP.pendingCount || 0);
    setTimeout(maybeScrollToBankingBox, 120);
  }


  function ensureSetupButton() {
    if ($("#fb-setup-button")) return;

    const btn = document.createElement("button");
    btn.id = "fb-setup-button";
    btn.type = "button";
    btn.textContent = "🪙 Setup";
    btn.title = "Open Faction Bankers settings";
    btn.addEventListener("click", () => {
      openOverlay();
      setTimeout(() => {
        const settingsTab = document.querySelector('.fb-tab[data-tab="settings"]');
        if (settingsTab) settingsTab.click();
      }, 150);
    });

    document.body.appendChild(btn);

    if (GM_getValue(K_API_KEY, "")) {
      btn.classList.add("fb-hide");
    }
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
        <button class="fb-tab" data-tab="leaders" type="button">Leaders</button>
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
      const tabName = GM_getValue(K_API_KEY, "") ? "banker" : "settings";
      const tab = document.querySelector(`.fb-tab[data-tab="${tabName}"]`);
      if (tab) tab.click();
    }, 150);
  }

  function openBankerSettings() {
    openOverlay();

    setTimeout(() => {
      const tab = document.querySelector('.fb-tab[data-tab="settings"]');
      if (tab) tab.click();
    }, 150);
  }

  function activeTab() {
    const btn = $(".fb-tab.active");
    return btn?.dataset?.tab || "request";
  }

  function setCoinAlert(count) {
    let coin = $("#fb-bank-coin-clean");
    if (!coin && isTornPage()) {
      mountCoin();
      coin = $("#fb-bank-coin-clean");
    }
    const setupBtn = $("#fb-setup-button");
    const n = Number(count || 0);
    const hasKey = !!GM_getValue(K_API_KEY, "");
    const canBank = !!(APP.me?.is_banker || APP.me?.is_admin);
    APP.pendingCount = n;

    if (coin) {
      coin.setAttribute("data-count", String(n > 99 ? "99+" : n));

      // Header coin stays visible; only turns red for bankers/admin with pending requests.
      coin.classList.add("fb-banker-visible");

      if (canBank && n > 0) {
        coin.classList.add("fb-alert");
        coin.title = `${n} pending faction bank request${n === 1 ? "" : "s"} — tap to approve and send`;
      } else {
        coin.classList.remove("fb-alert");
        coin.title = hasKey ? "Factional Banking" : "Factional Banking setup/login";
      }
    }

    if (setupBtn) {
      if (hasKey) setupBtn.classList.add("fb-hide");
      else setupBtn.classList.remove("fb-hide");
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


  function factionOptions(selected = GM_getValue(K_TARGET_FACTION, "")) {
    const own = APP.me?.faction_id ? [{ faction_id: APP.me.faction_id, faction_name: APP.me.faction_name || APP.me.faction_id }] : [];
    const items = own.length ? own : (Array.isArray(APP.factions) && APP.factions.length ? APP.factions : DEFAULT_FACTIONS);

    return items.map((f) => {
      const id = String(f.faction_id || "");
      const name = String(f.faction_name || id || "Your faction");
      return `<option value="${esc(id)}" selected>${esc(name)}</option>`;
    }).join("");
  }

  function rememberFactionFromSelect(sel) {
    const val = $(sel)?.value || "";
    if (val) GM_setValue(K_TARGET_FACTION, val);
    return val;
  }

  function selectedFactionFromPage() {
    return (
      APP.me?.faction_id ||
      $("#fb-target-faction")?.value ||
      $("#fb-built-faction")?.value ||
      GM_getValue(K_TARGET_FACTION, "") ||
      ""
    );
  }

  function factionLabelById(factionId) {
    const id = String(factionId || "");
    const found = (APP.factions || []).find((f) => String(f.faction_id) === id);
    return found?.faction_name || id;
  }



  function openBalancePageForCapture() {
    GM_setValue(K_BALANCE_CAPTURE, "1");
    setFactionBalance(null, "", "Opening balance page...");

    const target = "https://www.torn.com/factions.php?step=your#/tab=controls";
    if (location.href.startsWith("https://www.torn.com/factions.php") || location.href.startsWith("https://torn.com/factions.php")) {
      // Try to open the controls/bank area without leaving first. If Torn/PDA does not switch tabs,
      // the URL below will force the faction page back into the right area.
      try { clickTextButton(["controls", "bank", "give money", "deposit", "vault"]); } catch {}
      setTimeout(() => { window.location.href = target; }, 350);
    } else {
      window.location.href = target;
    }
  }

  function balanceCaptureWanted() {
    return String(GM_getValue(K_BALANCE_CAPTURE, "")) === "1";
  }

  function stopBalanceCapture(ok) {
    if (ok) GM_setValue(K_BALANCE_CAPTURE, "");
  }

  function tryOpenTornBalanceControls() {
    // The exact tab names vary between Torn desktop/PDA/iPhone. Click a few safe labels only.
    try { clickTextButton(["controls", "bank", "give money", "deposit", "vault", "balance"]); } catch {}
  }

  function startBalanceCaptureLoop() {
    if (!isOwnFactionPage() || !balanceCaptureWanted()) return;

    let tries = 0;
    const status = () => document.querySelector("#fb-built-status");
    const timer = setInterval(() => {
      tries += 1;
      tryOpenTornBalanceControls();

      if (detectFactionBalanceFromPage()) {
        stopBalanceCapture(true);
        mountBuiltInBankerBox();
        const st = status();
        if (st) st.textContent = `Balance found: ${money(APP.balanceAmount || 0)}`;
        clearInterval(timer);
        return;
      }

      if (tries === 1 || tries === 4 || tries === 8) {
        const st = status();
        if (st) st.textContent = "Looking for Torn's balance line...";
      }

      if (tries >= 28) {
        setFactionBalance(null, "", "Balance not visible on this page yet");
        mountBuiltInBankerBox();
        const st = status();
        if (st) st.textContent = "Could not see your balance. Tap Enter Manually, or open Faction → Controls → Give Money and tap Refresh.";
        clearInterval(timer);
      }
    }, 650);
  }

  function parseMoneyAmount(text) {
    const raw = String(text || "");
    const m = raw.match(/\$\s*([0-9][0-9,]*)/);
    if (!m) return null;
    const n = Number(String(m[1] || "").replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function parseBalanceInput(raw) {
    const cleaned = String(raw || "").replace(/[^0-9]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function setManualBalance(amount) {
    const n = parseBalanceInput(amount);
    if (n === null) return false;
    GM_setValue(K_MANUAL_BALANCE_AMOUNT, String(n));
    GM_setValue(K_MANUAL_BALANCE_TEXT, money(n));
    APP.balanceAmount = n;
    APP.balanceText = money(n);
    APP.balanceSource = "manual";
    APP.balanceUpdatedAt = Date.now();
    GM_setValue("fb_last_personal_balance_amount_v2", String(n));
    GM_setValue("fb_last_personal_balance_text_v2", money(n));
    return true;
  }

  function promptManualBalance() {
    const current = Number.isFinite(Number(APP.balanceAmount)) ? String(APP.balanceAmount) : "";
    const raw = prompt("Enter your faction bank balance. Example: 25000000", current);
    if (raw === null) return;
    if (!setManualBalance(raw)) {
      alert("Enter numbers only, example: 25000000");
      return;
    }
    mountBuiltInBankerBox();
    if (APP.open) renderBody(activeTab());
  }

  function loadManualBalanceCache() {
    const manual = Number(GM_getValue(K_MANUAL_BALANCE_AMOUNT, ""));
    const manualText = GM_getValue(K_MANUAL_BALANCE_TEXT, "");
    if (Number.isFinite(manual) && manual >= 0 && manualText) {
      APP.balanceAmount = Math.floor(manual);
      APP.balanceText = manualText;
      APP.balanceSource = "manual";
      return true;
    }
    return false;
  }

  function setFactionBalance(amount, source = "", fallbackText = "Balance unavailable") {
    if (Number.isFinite(Number(amount)) && Number(amount) >= 0) {
      APP.balanceAmount = Math.floor(Number(amount));
      APP.balanceText = money(APP.balanceAmount);
      APP.balanceSource = source || "detected";
      APP.balanceUpdatedAt = Date.now();
      GM_setValue("fb_last_personal_balance_amount_v2", String(APP.balanceAmount));
      GM_setValue("fb_last_personal_balance_text_v2", APP.balanceText);
      return true;
    }

    if (loadManualBalanceCache()) return true;

    const cached = Number(GM_getValue("fb_last_personal_balance_amount_v2", ""));
    const cachedText = GM_getValue("fb_last_personal_balance_text_v2", "");
    if (Number.isFinite(cached) && cached >= 0 && cachedText) {
      APP.balanceAmount = Math.floor(cached);
      APP.balanceText = cachedText;
      APP.balanceSource = "last verified";
      return true;
    }

    APP.balanceAmount = null;
    APP.balanceText = fallbackText || "Balance unavailable";
    APP.balanceSource = "";
    return false;
  }

  function deductRequestedAmountFromLocalBalance(requestedAmount) {
    const amt = Number(requestedAmount || 0);
    const current = Number(APP.balanceAmount);

    // Only adjust when we already have a real/manual/saved balance showing.
    // This is an estimated local balance until the user hits Sync/Refresh/Enter Manually again.
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isFinite(current) || current < 0) return false;

    const next = Math.max(0, Math.floor(current - amt));
    APP.balanceAmount = next;
    APP.balanceText = money(next);
    APP.balanceSource = "estimated after request";
    APP.balanceUpdatedAt = Date.now();

    // Save it locally so the box keeps showing the reduced balance after PDA refreshes.
    GM_setValue("fb_last_personal_balance_amount_v2", String(next));
    GM_setValue("fb_last_personal_balance_text_v2", APP.balanceText);
    GM_setValue(K_MANUAL_BALANCE_AMOUNT, String(next));
    GM_setValue(K_MANUAL_BALANCE_TEXT, APP.balanceText);

    return true;
  }

  function detectFactionBalanceFromPage() {
    if (!isOwnFactionPage()) return false;

    const allText = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const exactPatterns = [
      /[A-Za-z0-9_\-]+(?:\'s|’s)\s+current\s+balance\s+is\s*\$\s*([0-9][0-9,]*)/i,
      /your\s+current\s+balance\s+is\s*\$\s*([0-9][0-9,]*)/i,
      /your\s+(?:faction\s+)?balance\s*(?:is|:)\s*\$\s*([0-9][0-9,]*)/i,
    ];
    for (const re of exactPatterns) {
      const m = allText.match(re);
      if (m) {
        const n = Number(String(m[1] || "").replace(/,/g, ""));
        if (Number.isFinite(n) && n >= 0) return setFactionBalance(n, "Torn balance page");
      }
    }

    // Be strict: only read the MEMBER'S own faction-bank balance, not faction vault money,
    // points, jackpot, or our own request amount field.
    const roots = Array.from(document.querySelectorAll("div, span, li, td, p, section, label"));
    let best = null;

    const badWords = [
      "request", "requested", "amount", "vault", "funds", "faction money",
      "money:", "points:", "merits:", "respect", "cost", "price", "donation",
      "armoury", "stock", "banker", "available banker"
    ];

    for (const el of roots) {
      if (!el || el.closest("#fb-built-in-box, #fb-overlay")) continue;
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 180 || !text.includes("$")) continue;

      const lower = text.toLowerCase();
      if (badWords.some((w) => lower.includes(w))) continue;

      // Torn normally labels this as: "Fries91's current balance is $0"
      // or "Your balance is $..." near the Give Money form.
      // We do NOT accept generic dollar amounts anymore because that caused wrong balances.
      let score = 0;
      if (/\bcurrent\s+balance\s+is\s*\$/i.test(text)) score += 160;
      if (/\b[a-z0-9_\-]+(?:\'s|’s)\s+current\s+balance\s+is\s*\$/i.test(text)) score += 180;
      if (/\byour\s+(faction\s+)?balance\b/i.test(text)) score += 140;
      if (/\bmy\s+(faction\s+)?balance\b/i.test(text)) score += 110;
      if (/\bbalance\s*[:\-]?\s*\$/i.test(text)) score += 80;
      if (/\$[\d,]+\s*\b(balance)\b/i.test(text)) score += 50;
      if (lower.includes("member balance")) score += 90;
      if (lower.includes("bank balance")) score += 35;
      if (score < 80) continue;

      const amount = parseMoneyAmount(text);
      if (amount === null) continue;
      if (!best || score > best.score) best = { amount, score, text };
    }

    if (best) return setFactionBalance(best.amount, "page verified");
    return false;
  }

  async function loadFactionBalance(force = false) {
    // Page text is the source of truth for personal faction-bank balance.
    // The API may expose vault/funds/member data, which is not always the user's exact bank balance.
    if (detectFactionBalanceFromPage()) return true;
    if (loadManualBalanceCache()) return true;

    if (!GM_getValue(K_API_KEY, "")) {
      setFactionBalance(null, "", "Save key to check balance");
      return false;
    }

    if (!force && APP.balanceUpdatedAt && Date.now() - APP.balanceUpdatedAt < 30000) return true;

    try {
      const res = await gmRequest("GET", "/api/banker/balance");
      if (res && res.ok && Number.isFinite(Number(res.balance))) {
        // API balance is only used when the page exact balance is not visible.
        return setFactionBalance(Number(res.balance), res.source || "api optional");
      }
      if (res && res.message) APP.balanceText = String(res.message);
    } catch (err) {
      // Balance is optional. Do not break the whole banking box if Torn/API cannot expose it.
      if (!APP.balanceAmount && !detectFactionBalanceFromPage()) {
        setFactionBalance(null, "", "Balance unavailable");
      }
    }

    return APP.balanceAmount !== null;
  }

  function balanceLineHtml() {
    const has = Number.isFinite(Number(APP.balanceAmount));
    const label = has ? money(APP.balanceAmount) : esc(APP.balanceText || "Balance unavailable");
    const src = APP.balanceSource ? ` (${APP.balanceSource})` : "";
    return `<div class="fb-balance-line"><div>Your balance: <b>${label}</b></div><span>${esc(src || "")}</span></div>`;
  }

  function currentTargetFactionId() {
    return (
      APP.me?.faction_id ||
      $("#fb-target-faction")?.value ||
      $("#fb-built-faction")?.value ||
      GM_getValue(K_TARGET_FACTION, "") ||
      ""
    );
  }

  async function loadBankerStatus(factionId = currentTargetFactionId()) {
    const fid = String(factionId || "").trim();
    if (!fid || !GM_getValue(K_API_KEY, "")) {
      APP.bankers = [];
      APP.bankerFactionId = "";
      APP.bankerStatusError = "Save API key, then refresh banker status.";
      return false;
    }

    try {
      const res = await gmRequest("GET", `/api/banker/status?faction_id=${encodeURIComponent(fid)}`);
      APP.bankers = (Array.isArray(res.items) ? res.items : []).filter((b) => !isHiddenBanker(b));
      APP.bankerFactionId = fid;
      APP.bankerStatusError = APP.bankers.length ? "" : "No bankers returned by Render for this faction.";
      return true;
    } catch (err) {
      // Keep the last good list so the request box does not flicker/disappear on PDA.
      APP.bankerFactionId = fid;
      APP.bankerStatusError = String(err?.message || err || "Banker status failed");
      if (!APP.bankers.length && Array.isArray(APP.manualBankers) && APP.manualBankers.length) {
        APP.bankers = APP.manualBankers.map((b) => ({
          player_id: String(b.banker_id || b.id || ""),
          name: String(b.banker_name || b.name || b.banker_id || b.id || "Banker"),
          status: "unknown",
          color: "gray",
          label: "Status unavailable",
          details: APP.bankerStatusError,
          is_available: false,
          has_pushover: !!b.has_pushover,
          source: "leaders",
        })).filter((b) => b.player_id && !isHiddenBanker(b));
      }
      if (!APP.bankers.length) {
        APP.bankers = [];
      }
      return false;
    }
  }

  function isFries91Banker(b) {
    const id = String(b?.player_id || "").trim();
    const name = String(b?.name || "").trim().toLowerCase();
    return id === "3679030" || name === "fries91";
  }

  function friesPhoneText(b) {
    if (isFries91Banker(b)) return " • pings directly to phone";
    if (b?.has_pushover) return " • phone ping";
    return "";
  }

  function isHiddenBanker(b) {
    const id = String(b?.player_id || "").trim().toLowerCase();
    const name = String(b?.name || "").trim().toLowerCase();
    return id === "pulsearts" || name === "pulsearts" || name.startsWith("pulsearts") || name === "pulse";
  }

  function visibleBankers() {
    return (Array.isArray(APP.bankers) ? APP.bankers : []).filter((b) => !isHiddenBanker(b));
  }

  function bankerOptions(selected = "") {
    const bankers = visibleBankers();
    const onlineCount = bankers.filter((b) => b.is_available || String(b.color || "").toLowerCase() === "green").length;
    const travelingCount = bankers.filter((b) => ["yellow", "blue"].includes(String(b.color || "").toLowerCase())).length;
    const offlineCount = Math.max(0, bankers.length - onlineCount - travelingCount);

    let anyLabel = "Any available banker";
    if (bankers.length) {
      const bits = [];
      if (onlineCount) bits.push(`${onlineCount} online`);
      if (travelingCount) bits.push(`${travelingCount} traveling`);
      if (offlineCount) bits.push(`${offlineCount} offline`);
      anyLabel = `Any banker — ${bits.join(", ") || bankers.length + " listed"}`;
    } else if (APP.bankerStatusError) {
      anyLabel = "Any banker — status unavailable";
    } else {
      anyLabel = "Any banker — loading";
    }

    const options = [`<option value="">${esc(anyLabel)}</option>`];

    for (const b of bankers) {
      const id = String(b.player_id || "");
      const name = String(b.name || id);
      const label = String(b.label || b.status_text || b.status || "Unknown");
      const details = String(b.details || "");
      const c = String(b.color || b.status_color || "").toLowerCase();
      const available = b.is_available || c === "green" ? "🟢" : (c === "yellow" || c === "blue" ? "🟡" : "🔴");
      const phoneText = friesPhoneText(b);
      const extra = details ? ` (${esc(details).slice(0, 42)})` : "";
      options.push(`<option value="${esc(id)}" ${String(selected) === id ? "selected" : ""}>${available} ${esc(name)} — ${esc(label)}${phoneText}${extra}</option>`);
    }

    return options.join("");
  }

  function bankerStatusPanel() {
    // Banker availability stays inside the dropdown only.
    // This keeps the faction page compact and avoids showing banker chips/rows under the dropdown.
    return "";
  }

  async function handleFactionChangeAndReload(selectId, rerender = true) {
    const val = rememberFactionFromSelect(selectId);
    await loadBankerStatus(val);
    if (rerender && APP.open) renderBody(activeTab());
    mountBuiltInBankerBox();
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
    if (tab === "leaders") renderLeadersTab();
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
        <label class="fb-label">Faction</label>
        <div class="fb-input" style="height:auto;">${esc(APP.me?.faction_name || "Your faction")}</div>
        <input id="fb-target-faction" type="hidden" value="${esc(APP.me?.faction_id || currentTargetFactionId())}">
        <div style="margin-top:8px;">${balanceLineHtml()}</div>
        <div class="fb-row" style="gap:6px; margin-top:8px;">
          <button id="fb-open-balance-page" class="fb-btn" type="button">Sync Balance</button>
          <button id="fb-refresh-balance" class="fb-btn" type="button">Refresh</button>
          <button id="fb-manual-balance" class="fb-btn blue" type="button">Enter Manually</button>
        </div>

        <label class="fb-label" style="margin-top:10px;">Choose banker now</label>
        <select id="fb-target-banker" class="fb-input fb-banker-select">
          ${bankerOptions($("#fb-target-banker")?.value || "")}
        </select>
        ${bankerStatusPanel()}

        <label class="fb-label" style="margin-top:10px;">Amount requested</label>
        <input id="fb-amount" class="fb-input" inputmode="numeric" placeholder="Example: 25000000">

        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-full-request" class="fb-btn blue" type="button">Request Full Balance</button>
        </div>

        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-submit-request" class="fb-btn gold" type="button">Send Amount Request</button>
          <button id="fb-refresh" class="fb-btn" type="button">Refresh</button>
        </div>

        <div class="fb-small" style="margin-top:8px;">
          Bankers are found from your faction roles automatically. Set the banker role name in Torn/Render as Banker, Treasurer, Leader, or Co-leader.
        </div>
      </div>
    `);

    $("#fb-submit-request")?.addEventListener("click", submitRequest);
    $("#fb-full-request")?.addEventListener("click", submitFullBalanceRequest);
    $("#fb-open-balance-page")?.addEventListener("click", openBalancePageForCapture);
    $("#fb-refresh-balance")?.addEventListener("click", async () => { await loadFactionBalance(true); renderRequestTab(); });
    $("#fb-manual-balance")?.addEventListener("click", promptManualBalance);
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
        ${bankerStatusPanel()}
      </div>
      ${cards}
    `);

    $("#fb-refresh-banker")?.addEventListener("click", () => refreshAll(true));

    $$("[data-fb-action]").forEach((btn) => {
      btn.addEventListener("click", () => bankerAction(btn.dataset.id, btn.dataset.fbAction));
    });

    $$("[data-fb-pay]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.fbPay === "approve-open") approveAndOpenBank(btn.dataset.id);
        else openSavedRequestInBank(btn.dataset.id);
      });
    });
  }


  function normalizedPayAmount(r) {
    if (!r || String(r.note || "") === FULL_BALANCE_NOTE) return "";
    const amount = Number(r.amount || 0);
    return Number.isFinite(amount) && amount > 0 ? String(Math.floor(amount)) : "";
  }

  function showPayNotice(text) {
    let notice = document.querySelector("#fb-pay-prefill-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "fb-pay-prefill-notice";
      notice.className = "fb-pay-notice";
      document.body.appendChild(notice);
    }
    notice.textContent = text;
    clearTimeout(showPayNotice._timer);
    showPayNotice._timer = setTimeout(() => notice.remove(), 7000);
  }

  function savePayPrefill(r) {
    if (!r) return false;
    const payload = {
      requestId: String(r.id || ""),
      playerId: String(r.requester_id || ""),
      playerName: String(r.requester_name || ""),
      amount: normalizedPayAmount(r),
      factionName: String(r.faction_name || ""),
      savedAt: Date.now(),
    };
    GM_setValue(K_PAY_PREFILL, JSON.stringify(payload));
    try {
      localStorage.setItem(K_PAY_PREFILL, JSON.stringify(payload));
    } catch {
      // PDA can block localStorage in some modes; GM storage is enough.
    }
    return true;
  }

  function getPayPrefill() {
    let raw = GM_getValue(K_PAY_PREFILL, "");
    if (!raw) {
      try { raw = localStorage.getItem(K_PAY_PREFILL) || ""; } catch { raw = ""; }
    }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || !data.playerId) return null;
      if (Date.now() - Number(data.savedAt || 0) > 20 * 60 * 1000) {
        clearPayPrefill();
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function clearPayPrefill() {
    GM_setValue(K_PAY_PREFILL, "");
    try { localStorage.removeItem(K_PAY_PREFILL); } catch {}
  }


  function incomingRequestIdFromUrl() {
    try {
      const url = new URL(location.href);
      return String(url.searchParams.get("fb_bank_req") || "").replace(/\D/g, "");
    } catch {
      return "";
    }
  }

  async function handleIncomingBankRequestUrl() {
    const reqId = incomingRequestIdFromUrl();
    if (!reqId || !GM_getValue(K_API_KEY, "")) return false;

    try {
      const res = await gmRequest("GET", `/api/banker/requests/${encodeURIComponent(reqId)}`);
      const item = res && res.item;
      if (!item) return false;
      savePayPrefill(item);
      showPayNotice("Bank request loaded from phone ping. Player and amount will auto-fill. Manually press Give Money.");
      setTimeout(tryPrefillFactionBankForm, 600);
      setTimeout(tryPrefillFactionBankForm, 1600);
      setTimeout(tryPrefillFactionBankForm, 3200);
      setTimeout(tryPrefillFactionBankForm, 5500);
      return true;
    } catch (err) {
      showPayNotice(`Could not load bank request #${reqId}: ${String(err.message || err).slice(0, 90)}`);
      return false;
    }
  }

  function openBankingPageForRequest(r) {
    if (!r) return;
    savePayPrefill(r);
    showPayNotice("Opening Torn faction bank. Player and amount will auto-fill when the bank form loads. You still manually press Give Money.");
    window.location.href = "https://www.torn.com/factions.php?step=your#/tab=controls";
  }

  function setNativeValue(input, value) {
    if (!input) return false;

    const val = String(value ?? "");

    try { input.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    try { input.focus(); } catch {}
    try { input.click(); } catch {}

    const isEditable = !!input.isContentEditable || String(input.getAttribute?.("contenteditable") || "").toLowerCase() === "true";

    if (isEditable) {
      try { input.textContent = val; } catch {}
      try { input.innerText = val; } catch {}
      try { input.setAttribute("data-value", val); } catch {}
    } else {
      // React/Torn-safe value setter. Some Torn fields ignore plain input.value = x.
      const proto = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const ownDescriptor = Object.getOwnPropertyDescriptor(input, "value");

      if (descriptor && descriptor.set && (!ownDescriptor || ownDescriptor.set !== descriptor.set)) {
        descriptor.set.call(input, val);
      } else {
        input.value = val;
      }

      try { input.setAttribute("value", val); } catch {}
    }

    const events = [
      new Event("input", { bubbles: true }),
      new Event("change", { bubbles: true }),
      new KeyboardEvent("keydown", { bubbles: true, key: val.slice(-1) || "0" }),
      new KeyboardEvent("keyup", { bubbles: true, key: val.slice(-1) || "0" }),
      new Event("blur", { bubbles: true }),
    ];

    // InputEvent is not always available in PDA, so keep it optional.
    try {
      events.unshift(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
    } catch {}

    events.forEach((ev) => {
      try { input.dispatchEvent(ev); } catch {}
    });

    try { input.focus(); } catch {}
    return true;
  }

  function isFactionBankerOwnInput(el) {
    return !!(
      el &&
      (el.closest?.("#fb-built-in-box") ||
       el.closest?.("#fb-overlay") ||
       el.closest?.("#fb-profile-bank-coin") ||
       el.id?.startsWith?.("fb-") ||
       String(el.className || "").includes("fb-"))
    );
  }

  function visibleInput(el) {
    if (!el || el.disabled) return false;
    const isEditable = !!el.isContentEditable || String(el.getAttribute?.("contenteditable") || "").toLowerCase() === "true";
    if (el.readOnly && !isEditable) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 30 && rect.height > 12;
  }

  function scoreInputFor(input, kind) {
    const s = [
      input.id,
      input.name,
      input.placeholder,
      input.getAttribute("aria-label"),
      input.className,
      input.closest("div")?.textContent,
    ].map((v) => String(v || "").toLowerCase()).join(" ");

    if (kind === "player") {
      return (s.includes("player") ? 40 : 0) +
        (s.includes("user") ? 25 : 0) +
        (s.includes("member") ? 25 : 0) +
        (s.includes("recipient") ? 35 : 0) +
        (s.includes("name") ? 15 : 0) +
        (s.includes("id") ? 10 : 0) -
        (s.includes("amount") || s.includes("money") || s.includes("cash") ? 50 : 0);
    }

    return (s.includes("amount") ? 45 : 0) +
      (s.includes("money") ? 30 : 0) +
      (s.includes("cash") ? 30 : 0) +
      (s.includes("give") ? 18 : 0) +
      (input.inputMode === "numeric" ? 15 : 0) +
      (input.type === "number" || input.type === "tel" ? 20 : 0) -
      (s.includes("player") || s.includes("user") || s.includes("member") ? 45 : 0);
  }

  function inputSignature(el) {
    const bits = [
      el?.id,
      el?.name,
      el?.placeholder,
      el?.getAttribute?.("aria-label"),
      el?.className,
      el?.closest?.("label")?.textContent,
      el?.parentElement?.textContent,
      el?.parentElement?.previousElementSibling?.textContent,
      el?.parentElement?.parentElement?.textContent,
    ];
    return bits.map((v) => String(v || "").toLowerCase()).join(" ");
  }

  function allUsableInputs() {
    return Array.from(document.querySelectorAll("input, textarea, [contenteditable=\"true\"]"))
      .filter((el) => !isFactionBankerOwnInput(el))
      .filter(visibleInput)
      .filter((el) => el.isContentEditable || !String(el.type || "").match(/hidden|submit|button|checkbox|radio/i));
  }

  function looksLikePlayerInput(el) {
    const s = inputSignature(el);
    return s.includes("search player") ||
      s.includes("player") ||
      s.includes("recipient") ||
      s.includes("user") ||
      s.includes("member") ||
      s.includes("name") ||
      s.includes("xid");
  }

  function looksLikeAmountInput(el) {
    const s = inputSignature(el);
    const type = String(el.type || "").toLowerCase();
    const mode = String(el.inputMode || "").toLowerCase();

    if (looksLikePlayerInput(el) && !s.includes("amount")) return false;

    return s.includes("amount") ||
      s.includes("money") ||
      s.includes("cash") ||
      s.includes("give money") ||
      s.includes("change balance") ||
      s.includes("$") ||
      mode === "numeric" ||
      type === "number" ||
      type === "tel";
  }

  function bestAmountInputNearDollar(inputs, playerInput) {
    const dollarNodes = Array.from(document.querySelectorAll("div, span, label, p"))
      .filter((el) => getCleanText(el).trim() === "$" || getCleanText(el).trim().startsWith("$"))
      .map((el) => el.getBoundingClientRect());

    const playerRect = playerInput?.getBoundingClientRect?.();

    const candidates = inputs.filter((input) => input !== playerInput && !looksLikePlayerInput(input));

    if (dollarNodes.length && candidates.length) {
      const scored = candidates.map((input) => {
        const r = input.getBoundingClientRect();
        let best = 999999;
        for (const d of dollarNodes) {
          const dist = Math.abs(r.top - d.top) + Math.abs(r.left - d.right);
          best = Math.min(best, dist);
        }
        return { input, score: best };
      }).sort((a, b) => a.score - b.score);
      if (scored[0] && scored[0].score < 250) return scored[0].input;
    }

    // Torn banking page often has player search first, then amount field below it.
    if (playerRect) {
      const below = candidates
        .filter((input) => {
          const r = input.getBoundingClientRect();
          return r.top > playerRect.top - 6;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      if (below.length) return below[0];
    }

    return candidates[0] || null;
  }

  function bestInput(kind, avoidInput = null) {
    const inputs = allUsableInputs();

    if (kind === "amount") {
      const scoredAmount = inputs
        .filter((el) => el !== avoidInput)
        .map((el) => ({ el, score: scoreInputFor(el, kind) + (looksLikeAmountInput(el) ? 40 : 0) }))
        .filter((x) => x.score > 10 && !looksLikePlayerInput(x.el))
        .sort((a, b) => b.score - a.score);

      if (scoredAmount[0]) return scoredAmount[0].el;
      return bestAmountInputNearDollar(inputs, avoidInput || bestInput("player"));
    }

    const scored = inputs.map((el) => ({ el, score: scoreInputFor(el, kind) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.el || null;
  }

  function findTornFactionAmountInput(playerInput) {
    const rawAmount = getPayPrefill()?.amount ? String(getPayPrefill().amount).replace(/[^0-9]/g, "") : "";
    const inputs = allUsableInputs().filter((el) => el !== playerInput && !looksLikePlayerInput(el));
    if (!inputs.length) return null;

    // Prefer the real Torn vault amount field: it is usually directly beside/below a lone "$" prefix.
    const dollarEls = Array.from(document.querySelectorAll("div, span, label, b, strong"))
      .filter((el) => !el.closest?.("#fb-built-in-box") && !el.closest?.("#fb-overlay"))
      .filter((el) => getCleanText(el).trim() === "$" || getCleanText(el).trim() === "$")
      .map((el) => el.getBoundingClientRect());

    if (dollarEls.length) {
      const scored = inputs.map((input) => {
        const r = input.getBoundingClientRect();
        let best = 999999;
        for (const d of dollarEls) {
          // amount box normally starts just to the right of the $ prefix and on the same row
          const dist = Math.abs(r.top - d.top) * 3 + Math.abs(r.left - d.right);
          best = Math.min(best, dist);
        }
        return { input, score: best };
      }).sort((a, b) => a.score - b.score);
      if (scored[0] && scored[0].score < 900) return scored[0].input;
    }

    if (playerInput) {
      const pr = playerInput.getBoundingClientRect();
      const below = inputs
        .map((input) => ({ input, r: input.getBoundingClientRect() }))
        .filter(({ r }) => r.top > pr.bottom - 8 && r.top < pr.bottom + 180)
        .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
      if (below.length) return below[0].input;
    }

    return bestInput("amount", playerInput);
  }

  function fillTornAmountStrong(playerInput, amount) {
    const cleanAmount = String(amount || "").replace(/[^0-9]/g, "");
    if (!cleanAmount) return false;

    const amountInput = findTornFactionAmountInput(playerInput);
    if (!amountInput) return false;

    const ok = setNativeValue(amountInput, cleanAmount);
    try {
      amountInput.focus();
      amountInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "1" }));
      amountInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "1" }));
      amountInput.blur();
    } catch {}
    return ok;
  }

  function tapElementHard(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    const r = el.getBoundingClientRect?.();
    const x = r ? Math.max(2, Math.min(window.innerWidth - 2, r.left + Math.min(r.width - 2, Math.max(2, r.width / 2)))) : 10;
    const y = r ? Math.max(2, Math.min(window.innerHeight - 2, r.top + Math.min(r.height - 2, Math.max(2, r.height / 2)))) : 10;
    const target = document.elementFromPoint?.(x, y) || el;
    const chain = Array.from(new Set([target, target?.parentElement, el, el.closest?.("li, a, button, div")].filter(Boolean)));
    let ok = false;

    for (const node of chain) {
      try {
        node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", clientX: x, clientY: y }));
      } catch {}
      try { node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true })); } catch {}
      try { node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch {}
      try { node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch {}
      try { node.click(); ok = true; } catch {}
      try { node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch {}
      try { node.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true })); } catch {}
      try { node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch", clientX: x, clientY: y })); } catch {}
    }
    return ok;
  }

  function closeKeyboardAndAutocomplete(playerInput) {
    try {
      const el = playerInput || document.activeElement;
      if (el) {
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
        el.blur();
      }
    } catch {}
  }

  function clickPlayerAutocompleteChoice(data) {
    const name = String(data?.playerName || "").toLowerCase();
    const id = String(data?.playerId || "");
    if (!name && !id) return false;

    const ownSelectors = "#fb-built-in-box, #fb-overlay";
    const all = Array.from(document.querySelectorAll("li, div, span, a, button"))
      .filter((el) => !el.closest?.(ownSelectors))
      .filter((el) => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width < 25 || r.height < 10 || r.top < 0 || r.top > window.innerHeight) return false;
        const txt = getCleanText(el).toLowerCase();
        if (!txt || txt.length > 180) return false;
        if (id && !txt.includes(id)) return false;
        if (name && !txt.includes(name)) return false;
        if (txt.includes("friends") || txt.includes("company") || txt === "all" || txt === "faction") return false;
        return true;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const txt = getCleanText(el).toLowerCase();
        let score = 0;
        if (id && txt.includes(id)) score += 150;
        if (name && txt.includes(name)) score += 100;
        if (/\[[0-9]+\]/.test(txt)) score += 45;
        if (el.tagName === "LI") score += 55;
        if (el.tagName === "A" || el.tagName === "BUTTON") score += 35;
        if (r.height >= 22 && r.height <= 58) score += 45;
        if (r.width >= 120 && r.width <= 620) score += 20;
        score -= Math.max(0, (r.width * r.height - 35000) / 900); // avoid giant wrappers
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    const choice = all[0]?.el;
    let ok = false;
    if (choice) ok = tapElementHard(choice);

    // PDA fallback: Enter often accepts the highlighted Torn autocomplete result.
    const active = document.activeElement;
    try {
      if (active) {
        active.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
        active.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
      }
    } catch {}

    setTimeout(() => closeKeyboardAndAutocomplete(active), 120);
    return ok;
  }

  function findInputBesideDollarPrefix() {
    const ownSelectors = "#fb-built-in-box, #fb-overlay";
    const dollarEls = Array.from(document.querySelectorAll("div, span, label, b, strong, i"))
      .filter((el) => !el.closest?.(ownSelectors))
      .filter((el) => /^\s*\$\s*$/.test(String(el.textContent || "")) || /^\s*\$\s*$/.test(String(el.getAttribute?.("aria-label") || "")));

    for (const dollar of dollarEls) {
      const scopes = [
        dollar.parentElement,
        dollar.parentElement?.parentElement,
        dollar.closest?.("div"),
        dollar.closest?.("li"),
      ].filter(Boolean);

      for (const scope of scopes) {
        const inputs = Array.from(scope.querySelectorAll?.("input, textarea, [contenteditable=\"true\"]") || [])
          .filter((el) => !el.closest?.(ownSelectors))
          .filter((el) => el.isContentEditable || !String(el.type || "").match(/hidden|submit|button|checkbox|radio/i))
          .filter((el) => !looksLikePlayerInput(el))
          .filter((el) => {
            const r = el.getBoundingClientRect?.();
            return r && r.width > 45 && r.height > 14;
          });
        if (inputs.length) return inputs[0];
      }

      // PDA Torn sometimes renders the $ block and the input as neighboring siblings.
      let n = dollar.nextElementSibling;
      for (let i = 0; i < 5 && n; i += 1, n = n.nextElementSibling) {
        const input = n.matches?.("input, textarea, [contenteditable=\"true\"]") ? n : n.querySelector?.("input, textarea, [contenteditable=\"true\"]");
        if (input && !input.closest?.(ownSelectors) && !looksLikePlayerInput(input)) return input;
      }
    }

    // Visual fallback: choose the first blank input below the selected player field and inside the Give Money block.
    const player = bestInput("player");
    if (player) {
      const pr = player.getBoundingClientRect();
      const candidates = allUsableInputs()
        .filter((el) => el !== player && !looksLikePlayerInput(el))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.top > pr.bottom - 4 && r.top < pr.bottom + 160 && r.width > 100)
        .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
      if (candidates[0]) return candidates[0].el;
    }

    return null;
  }

  function setTornAmountDirect(amount) {
    const cleanAmount = String(amount || "").replace(/[^0-9]/g, "");
    if (!cleanAmount) return false;
    const el = findInputBesideDollarPrefix();
    if (!el) return false;
    const ok = setNativeValue(el, cleanAmount);
    try {
      el.focus();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: cleanAmount.slice(-1) || "0" }));
      el.blur();
    } catch {}
    return ok && String(el.value || "").replace(/[^0-9]/g, "") === cleanAmount;
  }

  function forceFillTornDollarAmount(amount) {
    const cleanAmount = String(amount || "").replace(/[^0-9]/g, "");
    if (!cleanAmount) return false;

    const ownSelectors = "#fb-built-in-box, #fb-overlay";
    const player = bestInput("player");
    const inputs = Array.from(document.querySelectorAll("input, textarea, [contenteditable=\"true\"]"))
      .filter((el) => !el.closest?.(ownSelectors))
      .filter((el) => el.isContentEditable || !String(el.type || "").match(/hidden|submit|button|checkbox|radio/i))
      .filter((el) => el !== player && !looksLikePlayerInput(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 14;
      });

    const dollarRects = Array.from(document.querySelectorAll("div, span, label, b, strong"))
      .filter((el) => !el.closest?.(ownSelectors))
      .filter((el) => getCleanText(el).trim() === "$" || /^\$\s*$/.test(getCleanText(el).trim()))
      .map((el) => el.getBoundingClientRect());

    let candidates = inputs.map((input) => {
      const r = input.getBoundingClientRect();
      let score = 999999;
      for (const d of dollarRects) {
        const sameRow = Math.abs((r.top + r.height / 2) - (d.top + d.height / 2));
        const rightOfDollar = Math.max(0, r.left - d.right);
        score = Math.min(score, sameRow * 8 + rightOfDollar + Math.abs(r.top - d.top));
      }
      if (player) {
        const pr = player.getBoundingClientRect();
        if (r.top > pr.bottom - 6 && r.top < pr.bottom + 180) score -= 250;
        if (r.left > pr.left - 80 && r.left < pr.left + 160) score -= 80;
      }
      return { input, score };
    }).sort((a, b) => a.score - b.score);

    for (const c of candidates.slice(0, 4)) {
      const el = c.input;
      if (el.disabled) continue;
      if (setNativeValue(el, cleanAmount)) {
        try {
          el.focus();
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.blur();
        } catch {}
        if (String(el.value || "").replace(/[^0-9]/g, "") === cleanAmount) return true;
      }
    }

    return false;
  }

  function clickTextButton(words) {
    const wanted = words.map((w) => String(w).toLowerCase());
    const nodes = Array.from(document.querySelectorAll("button, a, div, span, li"));
    const found = nodes.find((el) => {
      const text = getCleanText(el).toLowerCase();
      if (!text || text.length > 60) return false;
      return wanted.some((w) => text === w || text.includes(w));
    });
    if (found) {
      try { found.click(); } catch {}
      return true;
    }
    return false;
  }

  function tryPrefillFactionBankForm() {
    if (!isFactionPage()) return;
    const data = getPayPrefill();
    if (!data) return;

    // Try to expose the controls/banking form if Torn has it hidden behind tabs.
    clickTextButton(["controls", "bank", "give money", "vault"]);

    const playerInput = bestInput("player");
    let filled = false;

    if (playerInput) {
      filled = setNativeValue(playerInput, `${data.playerName} [${data.playerId}]`) || filled;
      setTimeout(() => clickPlayerAutocompleteChoice(data), 250);
      setTimeout(() => clickPlayerAutocompleteChoice(data), 650);
      setTimeout(() => clickPlayerAutocompleteChoice(data), 1200);
    }

    if (data.amount) {
      filled = setTornAmountDirect(data.amount) || fillTornAmountStrong(playerInput, data.amount) || forceFillTornDollarAmount(data.amount) || filled;
    }

    // Some Torn/PDA builds enable/replace the amount field only after the player autocomplete is selected.
    // Keep trying and force the money into Torn's real $ input, never this script's amount box.
    if (playerInput && data.amount) {
      [250, 550, 900, 1400, 2200, 3400, 5200, 7600, 10500, 13500, 16500].forEach((delay) => {
        setTimeout(() => {
          clickPlayerAutocompleteChoice(data);
          closeKeyboardAndAutocomplete(playerInput);
          setTimeout(() => {
            setTornAmountDirect(data.amount);
            fillTornAmountStrong(playerInput, data.amount);
            forceFillTornDollarAmount(data.amount);
          }, 220);
        }, delay);
      });
    }

    if (filled) {
      showPayNotice(`Bank prefill ready for ${data.playerName} [${data.playerId}]${data.amount ? ` — $${Number(data.amount).toLocaleString()}` : " — Full Balance request"}. Manually press Give Money.`);
    }
  }

  function openSavedRequestInBank(id) {
    const r = APP.requests.find((x) => String(x.id) === String(id));
    if (!r) return;
    openBankingPageForRequest(r);
  }

  async function approveAndOpenBank(id) {
    if (APP.busy || !id) return;
    const r = APP.requests.find((x) => String(x.id) === String(id));
    if (!r) return;

    APP.busy = true;
    try {
      await gmRequest("POST", `/api/banker/requests/${encodeURIComponent(id)}/approve`, { note: "" });
      openBankingPageForRequest(r);
    } catch (err) {
      const msg = String(err?.message || err || "");

      // If Render says the active request is already gone, treat that as success.
      // This happens when PDA double-taps, refreshes late, or a local backup tries to re-add it.
      if (/active request not found|request not found|404/i.test(msg)) {
        rememberClosedRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        const label = action === "deny" ? "denied" : action === "approve" ? "approved" : "completed";
        if (activeTab() === "banker" || activeTab() === "my") {
          renderBody(activeTab());
          const body = $("#fb-body");
          if (body) {
            body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-success">Request #${esc(id)} was already cleared. It has been removed locally too.</div></div>`);
          }
        } else {
          renderBody(activeTab());
        }
        return;
      }

      setBody(`
        <div class="fb-box">
          <div class="fb-error">${esc(msg)}</div>
          <div class="fb-row" style="margin-top:10px;">
            <button id="fb-force-clear-local" class="fb-btn gold" type="button">Hide This Request Locally</button>
            <button id="fb-retry-action" class="fb-btn" type="button">Retry</button>
          </div>
        </div>
      `);
      $("#fb-force-clear-local")?.addEventListener("click", () => {
        rememberClosedRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        renderBody(activeTab());
      });
      $("#fb-retry-action")?.addEventListener("click", () => bankerAction(id, action));
    } finally {
      APP.busy = false;
    }
  }

  function requestCard(r) {
    const id = esc(r.id);
    const status = String(r.status || "pending").toLowerCase();
    const isBanker = !!APP.me?.is_banker;

    const created = r.created_at ? esc(r.created_at) : "";
    const requester = esc(r.requester_name || `User ${r.requester_id || ""}`);
    const targetFaction = esc(r.faction_name || factionLabelById(r.faction_id) || "Faction");
    const handledBy = r.handled_by_name ? `<div class="fb-small">Handled by: ${esc(r.handled_by_name)}</div>` : "";
    const preferredBanker = r.selected_banker_name || r.selected_banker_id
      ? `<div class="fb-small">Preferred banker: ${esc(r.selected_banker_name || r.selected_banker_id)}</div>`
      : `<div class="fb-small">Preferred banker: Any available banker</div>`;

    let actions = "";

    if (isBanker && status === "pending") {
      actions = `
        <div class="fb-row" style="margin-top:10px;">
          <a class="fb-btn pay" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(String(r.requester_id || ""))}" target="_blank" rel="noopener">Open Member</a>
          <button class="fb-btn gold" data-id="${id}" data-fb-pay="approve-open" type="button">Approve + Open Bank</button>
          <button class="fb-btn green" data-id="${id}" data-fb-action="approve" type="button">Approve Only</button>
          <button class="fb-btn blue" data-id="${id}" data-fb-action="paid" type="button">Mark Complete</button>
          <button class="fb-btn red" data-id="${id}" data-fb-action="deny" type="button">Deny</button>
        </div>
      `;
    }

    if (isBanker && status === "approved") {
      actions = `
        <div class="fb-row" style="margin-top:10px;">
          <a class="fb-btn pay" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(String(r.requester_id || ""))}" target="_blank" rel="noopener">Open Member</a>
          <button class="fb-btn gold" data-id="${id}" data-fb-pay="open" type="button">Open Bank Page</button>
          <button class="fb-btn blue" data-id="${id}" data-fb-action="paid" type="button">Mark Complete</button>
          <button class="fb-btn red" data-id="${id}" data-fb-action="deny" type="button">Deny</button>
        </div>
      `;
    }

    return `
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">${requester} requested ${String(r.note || "") === FULL_BALANCE_NOTE ? "Full Balance" : money(r.amount)}</div>
            <div class="fb-request-meta">For ${targetFaction} • Request #${id}${created ? ` • ${created}` : ""}</div>
          </div>
          ${statusPill(status)}
        </div>

        ${String(r.note || "") === FULL_BALANCE_NOTE ? `<div class="fb-request-note">Full balance requested.</div>` : ""}

        ${preferredBanker}
        ${handledBy}
        ${r.bank_note ? `<div class="fb-small">Bank note: ${esc(r.bank_note)}</div>` : ""}

        ${actions}
      </div>
    `;
  }

  async function loadLeaderBankers() {
    APP.leaderLoadError = "";
    try {
      const res = await gmRequest("GET", "/api/banker/leaders");
      APP.manualBankers = Array.isArray(res.items) ? res.items : [];
      APP.leaderRoleNames = Array.isArray(res.role_names) ? res.role_names : [];
      APP.defaultRoleNames = Array.isArray(res.default_role_names) ? res.default_role_names : [];
      return true;
    } catch (err) {
      APP.leaderLoadError = String(err?.message || err || "Could not load leader banker list");
      APP.manualBankers = [];
      return false;
    }
  }

  async function addLeaderBanker() {
    if (APP.busy) return;
    const bankerId = String($("#fb-leader-banker-id")?.value || "").replace(/[^0-9]/g, "").trim();
    const bankerName = String($("#fb-leader-banker-name")?.value || "").trim();
    const pushoverKey = String($("#fb-leader-pushover")?.value || "").trim();

    if (!bankerId) {
      renderLeadersTab(`<div class="fb-error">Enter the banker Torn ID.</div>`);
      return;
    }

    APP.busy = true;
    try {
      const res = await gmRequest("POST", "/api/banker/leaders/add", {
        banker_id: bankerId,
        banker_name: bankerName || bankerId,
        pushover_key: pushoverKey,
      });
      await loadLeaderBankers();
      await loadBankerStatus(currentTargetFactionId());
      mountBuiltInBankerBox();
      renderLeadersTab(`<div class="fb-success">Banker saved.${res.test_ping_sent ? " Test phone ping sent." : ""}</div>`);
    } catch (err) {
      renderLeadersTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
    } finally {
      APP.busy = false;
    }
  }

  async function removeLeaderBanker(bankerId) {
    if (APP.busy || !bankerId) return;
    APP.busy = true;
    try {
      await gmRequest("POST", "/api/banker/leaders/remove", { banker_id: bankerId });
      await loadLeaderBankers();
      await loadBankerStatus(currentTargetFactionId());
      mountBuiltInBankerBox();
      renderLeadersTab(`<div class="fb-success">Banker removed.</div>`);
    } catch (err) {
      renderLeadersTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
    } finally {
      APP.busy = false;
    }
  }

  async function addLeaderRoleName() {
    if (APP.busy) return;
    const roleName = String($("#fb-leader-role-name")?.value || "").trim();

    if (!roleName) {
      renderLeadersTab(`<div class="fb-error">Enter the faction role name that should count as a banker.</div>`);
      return;
    }

    APP.busy = true;
    try {
      await gmRequest("POST", "/api/banker/leaders/roles/add", { role_name: roleName });
      await loadLeaderBankers();
      await loadBankerStatus(currentTargetFactionId());
      mountBuiltInBankerBox();
      renderLeadersTab(`<div class="fb-success">Banker role saved. Anyone in your faction with that role should show as a banker.</div>`);
    } catch (err) {
      renderLeadersTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
    } finally {
      APP.busy = false;
    }
  }

  async function removeLeaderRoleName(roleName) {
    if (APP.busy || !roleName) return;
    APP.busy = true;
    try {
      await gmRequest("POST", "/api/banker/leaders/roles/remove", { role_name: roleName });
      await loadLeaderBankers();
      await loadBankerStatus(currentTargetFactionId());
      mountBuiltInBankerBox();
      renderLeadersTab(`<div class="fb-success">Banker role removed.</div>`);
    } catch (err) {
      renderLeadersTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
    } finally {
      APP.busy = false;
    }
  }

  function renderLeadersTab(msg = "") {
    const canManage = !!APP.me?.can_manage_leaders || !!APP.me?.is_admin || !!APP.me?.is_banker;

    if (!canManage) {
      setBody(`
        <div class="fb-box fb-hero-card">
          <div class="fb-request-title">Leaders</div>
          <div class="fb-error" style="margin-top:6px;">Leader/banker access is required to manage bankers.</div>
          <div class="fb-small" style="margin-top:8px;">This tab is for the leader team of your own faction only.</div>
        </div>
      `);
      return;
    }

    const factionName = APP.me?.faction_name || "Your faction";
    const yourRole = APP.me?.faction_role || (APP.me?.is_admin ? "Admin" : "Role not detected");

    const rows = (APP.manualBankers || []).map((b) => `
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">${esc(b.banker_name || b.name || b.banker_id)}</div>
            <div class="fb-small">ID: ${esc(b.banker_id || b.id)} ${b.has_pushover ? "• phone ping enabled" : "• no phone ping key saved"}</div>
          </div>
          <button class="fb-btn red" data-leader-remove="${esc(b.banker_id || b.id)}" type="button">Remove</button>
        </div>
      </div>
    `).join("") || `<div class="fb-box"><div class="fb-muted">No specific banker overrides yet. Add one only if role detection misses someone.</div></div>`;

    const roleRows = (APP.leaderRoleNames || []).map((role) => `
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">${esc(role)}</div>
            <div class="fb-small">Anyone in ${esc(factionName)} with this role shows as a banker.</div>
          </div>
          <button class="fb-btn red" data-leader-role-remove="${esc(role)}" type="button">Remove</button>
        </div>
      </div>
    `).join("") || `<div class="fb-box"><div class="fb-muted">No custom banker roles saved yet. Defaults are: ${esc((APP.defaultRoleNames || []).join(", ") || "Banker, Treasurer, Leader, Co-leader")}</div></div>`;

    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}
      ${APP.leaderLoadError ? `<div class="fb-box"><div class="fb-error">${esc(APP.leaderLoadError)}</div></div>` : ""}

      <div class="fb-box fb-hero-card">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">👑 Leaders • ${esc(factionName)}</div>
            <div class="fb-small">This setup only affects your own faction. Other factions get their own Leaders tab and their own roles.</div>
          </div>
          <span class="fb-pill approved">${esc(yourRole)}</span>
        </div>
        <div class="fb-flow-grid" style="margin-top:10px;">
          <div class="fb-flow-card"><b>1. Add roles</b><span>Type the exact Torn faction role that means “can bank” for your faction.</span></div>
          <div class="fb-flow-card"><b>2. Optional pings</b><span>Add specific banker IDs with Pushover keys for direct phone alerts.</span></div>
        </div>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">Banker role names</div>
        <div class="fb-small" style="margin-top:5px;">Examples: Banker, Treasurer, Finance, Vault Keeper, Money Manager, Co-Leader.</div>
        <label class="fb-label" style="margin-top:10px;">Faction role name</label>
        <input id="fb-leader-role-name" class="fb-input" placeholder="Example: Treasurer">
        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-leader-role-add" class="fb-btn gold" type="button">Add Banker Role</button>
          <button id="fb-leader-refresh" class="fb-btn" type="button">Refresh</button>
        </div>
      </div>
      ${roleRows}

      <div class="fb-box">
        <div class="fb-request-title">Specific banker override</div>
        <div class="fb-small" style="margin-top:5px;">Use this only if a banker does not show by role. Optional Pushover key lets that banker get phone pings directly.</div>
        <label class="fb-label" style="margin-top:10px;">Banker Torn ID</label>
        <input id="fb-leader-banker-id" class="fb-input" inputmode="numeric" placeholder="Example: 3679030">
        <label class="fb-label" style="margin-top:10px;">Banker name</label>
        <input id="fb-leader-banker-name" class="fb-input" placeholder="Example: Fries91">
        <label class="fb-label" style="margin-top:10px;">Pushover User Key optional</label>
        <input id="fb-leader-pushover" class="fb-input" placeholder="Paste their Pushover User Key for phone pings">
        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-leader-add" class="fb-btn gold" type="button">Add Banker</button>
        </div>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">Specific banker overrides</div>
        <div class="fb-mini-note">These are manual banker entries for ${esc(factionName)} only.</div>
      </div>
      ${rows}
    `);

    $("#fb-leader-role-add")?.addEventListener("click", addLeaderRoleName);
    $("#fb-leader-add")?.addEventListener("click", addLeaderBanker);
    $("#fb-leader-refresh")?.addEventListener("click", async () => {
      await loadLeaderBankers();
      renderLeadersTab();
    });
    $$('[data-leader-role-remove]').forEach((btn) => {
      btn.addEventListener("click", () => removeLeaderRoleName(btn.dataset.leaderRoleRemove));
    });
    $$('[data-leader-remove]').forEach((btn) => {
      btn.addEventListener("click", () => removeLeaderBanker(btn.dataset.leaderRemove));
    });
  }

  function renderSettings(msg = "") {
    const key = GM_getValue(K_API_KEY, "");
    const loggedIn = !!APP.me;
    const roleText = APP.me?.faction_role || (APP.me?.is_admin ? "Admin" : "role not detected");

    setBody(`
      ${msg ? `<div class="fb-box"><div class="${String(msg).toLowerCase().includes("saved") ? "fb-success" : "fb-error"}">${esc(msg)}</div></div>` : ""}

      <div class="fb-box fb-hero-card">
        <div class="fb-request-title">⚙️ Settings & Login</div>
        <div class="fb-small" style="margin-top:5px;">Login once with a limited Torn API key so Factional Banking can verify who you are and which faction you belong to.</div>
        <div class="fb-login-status ${loggedIn ? "" : "off"}" style="margin-top:10px;">
          <div>
            <b><span class="fb-status-dot ${loggedIn ? "ok" : "bad"}"></span>${loggedIn ? `Logged in as ${esc(APP.me.name || "Torn user")}` : "Not logged in yet"}</b>
            <div class="fb-small">${loggedIn ? `${esc(APP.me.faction_name || "Faction")} • ${esc(roleText)}` : "Save your key at the bottom, then tap Test Login."}</div>
          </div>
          <span class="fb-pill ${loggedIn ? "approved" : "denied"}">${loggedIn ? "Verified" : "Login needed"}</span>
        </div>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">How this app uses your Torn API key</div>
        <ul class="fb-legal-list">
          <li>Used to verify your Torn name, ID, faction, and role for request access.</li>
          <li>Used to show banker availability/status and your faction banking tools.</li>
          <li>Stored only in your userscript/PDA storage on your device, not displayed to other players.</li>
          <li>The backend receives the key only on API calls needed to verify account/faction data.</li>
          <li>The app does not ask for your Torn password and does not auto-click Give Money.</li>
        </ul>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">Why a limited API key?</div>
        <div class="fb-small" style="margin-top:6px; line-height:1.4;">
          A limited key is enough for this banking helper because it only needs identity/faction verification and safe read-only checks. Using the smallest useful key is the safer way to follow Torn-friendly API use.
        </div>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">Torn-friendly rules</div>
        <ul class="fb-legal-list">
          <li>Requests are a queue/notification helper only.</li>
          <li>Bankers still manually review and press Torn’s Give Money button themselves.</li>
          <li>Pushover phone pings are only notifications, not automated payments.</li>
          <li>Faction leaders manage their own banker roles in the Leaders tab.</li>
        </ul>
      </div>

      <div class="fb-box">
        <div class="fb-request-title">Login</div>
        <label class="fb-label" style="margin-top:10px;">Torn limited API key</label>
        <input id="fb-api-key" class="fb-input" value="${esc(key)}" placeholder="Paste Torn limited API key">
        <div class="fb-row" style="margin-top:10px;">
          <button id="fb-save-key" class="fb-btn gold" type="button">Save Key</button>
          <button id="fb-test-login" class="fb-btn" type="button">Test Login</button>
          <button id="fb-enable-notify" class="fb-btn blue" type="button">Enable In-App Ping</button>
        </div>
        <div class="fb-mini-note">Backend: <span style="color:#ffd36a;">${esc(BANKER_API_BASE)}</span></div>
      </div>
    `);

    $("#fb-save-key")?.addEventListener("click", () => {
      const keyInput = $("#fb-api-key")?.value?.trim() || "";
      GM_setValue(K_API_KEY, keyInput);
      APP.me = null;
      renderSettings("Saved. Tap Test Login to verify your faction login.");
    });

    $("#fb-test-login")?.addEventListener("click", () => refreshAll(true));
    $("#fb-enable-notify")?.addEventListener("click", requestNotifyPermission);
  }

  async function submitFullBalanceRequest() {
    if (APP.busy) return;

    const status = $("#fb-built-status");
    const targetFactionId = selectedFactionFromPage();
    const targetBankerId = $("#fb-target-banker")?.value || $("#fb-built-banker")?.value || "";

    if (!GM_getValue(K_API_KEY, "")) {
      if (status) status.textContent = "Save your API key in settings first";
      openOverlay();
      return;
    }

    if (!targetFactionId) {
      if (status) status.textContent = "Choose faction first";
      if (APP.open) renderRequestTab(`<div class="fb-error">Choose a faction banker group first.</div>`);
      return;
    }

    await loadFactionBalance(true);
    const detectedFullBalance = Number(APP.balanceAmount || 0);
    const sendDetectedAmount = Number.isFinite(detectedFullBalance) && detectedFullBalance > 0;

    APP.busy = true;
    if (status) status.textContent = sendDetectedAmount ? `Sending full balance request for ${money(detectedFullBalance)}...` : "Sending full balance request...";

    try {
      const res = await gmRequest("POST", "/api/banker/requests", {
        amount: sendDetectedAmount ? detectedFullBalance : 1,
        note: sendDetectedAmount ? `Full balance requested: ${money(detectedFullBalance)}` : FULL_BALANCE_NOTE,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });
      if (res && res.item) {
        upsertRequestItem(res.item);
        saveLocalRequest(res.item);
      }
      if (sendDetectedAmount) {
        deductRequestedAmountFromLocalBalance(detectedFullBalance);
      }

      GM_setValue(K_TARGET_FACTION, targetFactionId);
      if (status) status.textContent = sendDetectedAmount ? `Full balance request sent for ${money(detectedFullBalance)}` : `Full balance request sent to ${factionLabelById(targetFactionId)} bankers`;
      await refreshAll(true);

      if (APP.open) {
        renderRequestTab(`<div class="fb-success">${sendDetectedAmount ? `Full balance request sent for ${money(detectedFullBalance)}.` : `Full balance request sent to ${esc(factionLabelById(targetFactionId))} bankers.`}</div>`);
      }
    } catch (err) {
      if (status) status.textContent = err.message || "Request failed";
      if (APP.open) {
        renderRequestTab(`<div class="fb-error">${esc(err.message || err)}</div>`);
      }
    } finally {
      APP.busy = false;
    }
  }

  async function submitBuiltInRequest() {
    if (APP.busy) return;

    const amountRaw = ($("#fb-built-amount")?.value || "").replace(/[^\d]/g, "");
    const amount = Number(amountRaw);
    const note = "";
    const targetFactionId = $("#fb-built-faction")?.value || "";
    const targetBankerId = $("#fb-built-banker")?.value || "";
    const status = $("#fb-built-status");

    if (!GM_getValue(K_API_KEY, "")) {
      if (status) status.textContent = "Save your API key in settings first";
      openOverlay();
      return;
    }

    if (!targetFactionId) {
      if (status) status.textContent = "Choose faction first";
      return;
    }

    if (!amount || amount < 1) {
      if (status) status.textContent = "Enter a valid amount";
      return;
    }

    APP.busy = true;
    if (status) status.textContent = "Sending request...";

    try {
      const res = await gmRequest("POST", "/api/banker/requests", {
        amount,
        note,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });
      if (res && res.item) {
        upsertRequestItem(res.item);
        saveLocalRequest(res.item);
      }
      deductRequestedAmountFromLocalBalance(amount);
      GM_setValue(K_TARGET_FACTION, targetFactionId);
      $("#fb-built-amount").value = "";
      if (status) status.textContent = `Request sent to ${factionLabelById(targetFactionId)} bankers`;
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
    const note = "";
    const targetFactionId = $("#fb-target-faction")?.value || "";
    const targetBankerId = $("#fb-target-banker")?.value || "";

    if (!targetFactionId) {
      renderRequestTab(`<div class="fb-error">Choose a faction banker group first.</div>`);
      return;
    }

    if (!amount || amount < 1) {
      renderRequestTab(`<div class="fb-error">Enter a valid amount.</div>`);
      return;
    }

    APP.busy = true;
    renderRequestTab(`<div class="fb-muted">Sending request...</div>`);

    try {
      const res = await gmRequest("POST", "/api/banker/requests", {
        amount,
        note,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });
      if (res && res.item) {
        upsertRequestItem(res.item);
        saveLocalRequest(res.item);
      }
      deductRequestedAmountFromLocalBalance(amount);
      GM_setValue(K_TARGET_FACTION, targetFactionId);
      await refreshAll(true);
      const pingMsg = res && res.pushover_sent === false
        ? `<div class="fb-error" style="margin-top:6px;">Request saved, but Pushover did not confirm. Check Render env PUSHOVER_USER_KEY and PUSHOVER_API_TOKEN, or add banker Pushover keys in Leaders.</div>`
        : `<div class="fb-success" style="margin-top:6px;">Phone ping sent/queued.</div>`;
      renderRequestTab(`<div class="fb-success">Amount request sent to ${esc(factionLabelById(targetFactionId))} bankers.</div>${pingMsg}`);
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
      const res = await gmRequest("POST", `/api/banker/requests/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
        note,
      });

      // Do not wait for the next refresh to visually clear it. Torn/PDA can miss a refresh
      // or merge a local backup, so we close it locally immediately too.
      rememberClosedRequest(id);
      APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));

      const label = action === "deny" ? "denied" : action === "approve" ? "approved" : "completed";
      await refreshAll(true);

      if (activeTab() === "banker") {
        renderBankerTab();
        const body = $("#fb-body");
        if (body) {
          body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-success">Request #${esc(id)} ${esc(label)} and cleared from the active board.</div></div>`);
        }
      } else {
        renderBody(activeTab());
      }
    } catch (err) {
      const msg = String(err?.message || err || "");

      // If Render says the active request is already gone, treat that as success.
      // This happens when PDA double-taps, refreshes late, or a local backup tries to re-add it.
      if (/active request not found|request not found|404/i.test(msg)) {
        rememberClosedRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        const label = action === "deny" ? "denied" : action === "approve" ? "approved" : "completed";
        if (activeTab() === "banker" || activeTab() === "my") {
          renderBody(activeTab());
          const body = $("#fb-body");
          if (body) {
            body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-success">Request #${esc(id)} was already cleared. It has been removed locally too.</div></div>`);
          }
        } else {
          renderBody(activeTab());
        }
        return;
      }

      setBody(`
        <div class="fb-box">
          <div class="fb-error">${esc(msg)}</div>
          <div class="fb-row" style="margin-top:10px;">
            <button id="fb-force-clear-local" class="fb-btn gold" type="button">Hide This Request Locally</button>
            <button id="fb-retry-action" class="fb-btn" type="button">Retry</button>
          </div>
        </div>
      `);
      $("#fb-force-clear-local")?.addEventListener("click", () => {
        rememberClosedRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        renderBody(activeTab());
      });
      $("#fb-retry-action")?.addEventListener("click", () => bankerAction(id, action));
    } finally {
      APP.busy = false;
    }
  }



  function upsertRequestItem(item) {
    if (!item || !item.id) return;

    const id = String(item.id);
    const list = Array.isArray(APP.requests) ? APP.requests.slice() : [];
    const idx = list.findIndex((r) => String(r.id) === id);

    if (idx >= 0) list[idx] = item;
    else list.unshift(item);

    APP.requests = list;
  }

  function localRequestKey() {
    return `fb_local_requests_v1_${APP.me?.player_id || "guest"}`;
  }

  function getLocalRequests() {
    try {
      const raw = GM_getValue(localRequestKey(), "[]");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveLocalRequest(item) {
    if (!item || !item.id) return;
    const now = Date.now();
    const mine = getLocalRequests()
      .filter((r) => r && String(r.id) !== String(item.id))
      .filter((r) => !r._local_saved_at || now - Number(r._local_saved_at) < 1000 * 60 * 60 * 24 * 2);
    mine.unshift({ ...item, _local_saved_at: now, _local_backup: true });
    GM_setValue(localRequestKey(), JSON.stringify(mine.slice(0, 20)));
  }

  function closedRequestKey() {
    return `fb_closed_requests_v1_${APP.me?.player_id || "guest"}`;
  }

  function closedRequestGlobalKey() {
    return "fb_closed_requests_global_v1";
  }

  function readClosedIdsFromKey(key) {
    try {
      const raw = GM_getValue(key, "[]");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  function getClosedRequestIds() {
    return Array.from(new Set([
      ...readClosedIdsFromKey(closedRequestKey()),
      ...readClosedIdsFromKey(closedRequestGlobalKey()),
    ]));
  }

  function rememberClosedRequest(id) {
    if (!id) return;
    const nextLocal = [String(id), ...readClosedIdsFromKey(closedRequestKey())].filter(Boolean);
    const nextGlobal = [String(id), ...readClosedIdsFromKey(closedRequestGlobalKey())].filter(Boolean);
    GM_setValue(closedRequestKey(), JSON.stringify(Array.from(new Set(nextLocal)).slice(0, 120)));
    GM_setValue(closedRequestGlobalKey(), JSON.stringify(Array.from(new Set(nextGlobal)).slice(0, 120)));
    clearLocalRequest(id);
  }

  function clearLocalRequest(id) {
    if (!id) return;
    const keep = getLocalRequests().filter((r) => String(r?.id) !== String(id));
    GM_setValue(localRequestKey(), JSON.stringify(keep.slice(0, 20)));
  }

  function mergeLocalRequests(items) {
    const closed = new Set(getClosedRequestIds());
    const list = (Array.isArray(items) ? items.slice() : []).filter((r) => !closed.has(String(r?.id)));
    const ids = new Set(list.map((r) => String(r.id)));
    for (const r of getLocalRequests()) {
      if (!r || !r.id) continue;
      if (closed.has(String(r.id))) continue;
      if (!["pending", "approved"].includes(String(r.status || "pending").toLowerCase())) continue;
      if (!ids.has(String(r.id))) list.unshift(r);
    }
    return list;
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
        const body = `${req.requester_name || "Member"} requested ${String(req.note || "") === FULL_BALANCE_NOTE ? "Full Balance" : money(req.amount)} for ${req.faction_name || "Faction"}`;

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

  async function refreshFactionBoxData(force = false) {
    const key = GM_getValue(K_API_KEY, "");
    if (!key) {
      APP.bankerStatusError = "Save API key in Settings first.";
      mountBuiltInBankerBox();
      return false;
    }

    if (APP.quickRefreshing) return true;
    if (!force && Date.now() - (APP.lastQuickLoad || 0) < 45000) return true;

    APP.quickRefreshing = true;
    APP.lastQuickLoad = Date.now();

    try {
      APP.factions = APP.factions?.length ? APP.factions : DEFAULT_FACTIONS.slice();

      try {
        const factions = await gmRequest("GET", "/api/banker/factions");
        if (Array.isArray(factions.items) && factions.items.length) APP.factions = factions.items;
      } catch (ignore) {
        APP.factions = DEFAULT_FACTIONS.slice();
      }

      try {
        const me = await gmRequest("GET", "/api/banker/me");
        APP.me = me;
        if (APP.me?.can_manage_leaders || APP.me?.is_admin || APP.me?.is_banker) {
          await loadLeaderBankers();
        }
      } catch (meErr) {
        APP.bankerStatusError = String(meErr.message || meErr).slice(0, 90);
      }

      await loadBankerStatus(currentTargetFactionId());
      mountBuiltInBankerBox();
      return true;
    } catch (err) {
      APP.bankerStatusError = String(err.message || err).slice(0, 120);
      if (!APP.bankers || !APP.bankers.length) {
        APP.bankers = [{
          player_id: "3679030",
          name: "Fries91",
          status: "unknown",
          color: "gray",
          label: "Status check failed",
          details: APP.bankerStatusError,
          is_available: false,
        }];
      }
      mountBuiltInBankerBox();
      return false;
    } finally {
      APP.quickRefreshing = false;
    }
  }

  async function refreshHeaderCoinBadge(force = false) {
    const key = GM_getValue(K_API_KEY, "");
    if (!key || APP.headerRefreshing) return false;
    if (!force && Date.now() - (APP.lastHeaderBadgeLoad || 0) < 90000) return true;

    APP.headerRefreshing = true;
    APP.lastHeaderBadgeLoad = Date.now();

    try {
      const me = APP.me || await gmRequest("GET", "/api/banker/me");
      APP.me = me;

      if (!(me?.is_banker || me?.is_admin)) {
        setCoinAlert(0);
        return true;
      }

      const list = await gmRequest("GET", "/api/banker/requests");
      const items = Array.isArray(list.items) ? list.items : [];
      APP.requests = mergeLocalRequests(items);

      const pendingItems = APP.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending");
      setCoinAlert(pendingItems.length);
      notifyBankerForNewPending(pendingItems);
      return true;
    } catch (err) {
      const coin = $("#fb-bank-coin-clean");
      if (coin) coin.title = `Factional Banking — refresh missed Render once: ${String(err.message || err).slice(0, 80)}`;
      return false;
    } finally {
      APP.headerRefreshing = false;
    }
  }

  async function refreshAll(force = false) {
    const key = GM_getValue(K_API_KEY, "");
    if (!key) {
      setCoinAlert(0);
      if (APP.open) renderSettings("Add your Torn API key first.");
      return false;
    }

    if (!force && Date.now() - APP.lastLoad < 12000) return true;
    if (APP.refreshing) return true;

    APP.refreshing = true;
    APP.lastLoad = Date.now();

    try {
      // Keep dropdown usable even if the new factions endpoint is not deployed yet.
      APP.factions = APP.factions?.length ? APP.factions : DEFAULT_FACTIONS.slice();

      try {
        const factions = await gmRequest("GET", "/api/banker/factions");
        if (Array.isArray(factions.items) && factions.items.length) {
          APP.factions = factions.items;
        }
      } catch (factionErr) {
        APP.factions = DEFAULT_FACTIONS.slice();
      }

      const me = await gmRequest("GET", "/api/banker/me");
      APP.me = me;

      await loadFactionBalance(false);

      if (APP.me?.can_manage_leaders || APP.me?.is_admin || APP.me?.is_banker) {
        await loadLeaderBankers();
      }

      const list = await gmRequest("GET", "/api/banker/requests");
      APP.requests = mergeLocalRequests(Array.isArray(list.items) ? list.items : []);

      await loadBankerStatus(currentTargetFactionId());

      const pendingItems = APP.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending");
      const pending = pendingItems.length;

      setCoinAlert(pending);
      notifyBankerForNewPending(pendingItems);

      if (APP.open) renderBody(activeTab());
      return true;
    } catch (err) {
      APP.factions = APP.factions?.length ? APP.factions : DEFAULT_FACTIONS.slice();
      mountCoin();

      const subtitle = $("#fb-subtitle");
      if (subtitle) {
        subtitle.textContent = `Last refresh failed: ${String(err.message || err).slice(0, 80)}`;
      }

      // Do not wipe the current screen after a successful request.
      // Render can briefly miss one API call while waking/redeploying; keeping the last good board is better on PDA.
      if (APP.me) {
        if (APP.open) {
          const body = $("#fb-body");
          if (body && !body.querySelector("#fb-soft-network-error")) {
            body.insertAdjacentHTML("afterbegin", `
              <div id="fb-soft-network-error" class="fb-box">
                <div class="fb-error">Refresh missed Render once. Your request may still be saved.</div>
                <div class="fb-row" style="margin-top:8px;">
                  <button id="fb-retry-network" class="fb-btn gold" type="button">Retry</button>
                </div>
              </div>
            `);
            $("#fb-retry-network")?.addEventListener("click", () => {
              const box = $("#fb-soft-network-error");
              if (box) box.remove();
              refreshAll(true);
            });
          }
        }
        return false;
      }

      setCoinAlert(0);

      if (APP.open) {
        setBody(`
          <div class="fb-box">
            <div class="fb-error">${esc(err.message || err)}</div>
            <div class="fb-small" style="margin-top:8px;">
              The app is open, but Render did not answer one of the API calls. Make sure app.py is deployed and the service is awake.
            </div>
            <div class="fb-row" style="margin-top:10px;">
              <button id="fb-retry-network" class="fb-btn gold" type="button">Retry</button>
              <button id="fb-open-settings2" class="fb-btn" type="button">Settings</button>
            </div>
          </div>
        `);

        $("#fb-retry-network")?.addEventListener("click", () => refreshAll(true));
        $("#fb-open-settings2")?.addEventListener("click", () => {
          const settingsTab = document.querySelector('.fb-tab[data-tab="settings"]');
          if (settingsTab) settingsTab.click();
        });
      }
      return false;
    } finally {
      APP.refreshing = false;
    }
  }

  function clearBankerUiOnWrongPage() {
    if (!isOwnFactionPage()) {
      const box = document.querySelector("#fb-built-in-box");
      if (box) box.remove();
    }

    // Profile coin is disabled. Remove it everywhere.
    const profileCoin = document.querySelector("#fb-profile-bank-coin");
    if (profileCoin) profileCoin.remove();

    // Keep only the new header coin. Remove old legacy coin ids if they appear.
    document.querySelectorAll("#fb-bank-coin").forEach((el) => el.remove());
  }

  let mountTimer = null;
  let mountTries = 0;

  function pageMount(reason = "manual") {
    if (!isTornPage()) return;

    ensureStyles();
    clearBankerUiOnWrongPage();
    mountCoin();

    // Only create the overlay when the user taps Board/profile/header coin. Never auto-open it on normal pages.
    if (APP.open) ensureOverlay();

    if (isOwnFactionPage()) {
      mountBuiltInBankerBox();
      startBalanceCaptureLoop();

      // PDA-safe: only load factions/me/banker status for the quick box.
      // Do not call /api/banker/requests here because that uses the database and caused 500s.
      if (GM_getValue(K_API_KEY, "") && (Date.now() - (APP.lastQuickLoad || 0) > 45000 || reason === "url")) {
        refreshFactionBoxData(false);
      }
    }

    mountProfileBankCoin();
  }

  function scheduleMount(reason = "scheduled") {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(() => pageMount(reason), 450);
  }

  function boot() {
    if (!isTornPage() || APP.booted) return;

    ensureStyles();
    clearBankerUiOnWrongPage();
    mountCoin();

    APP.booted = true;

    // Do not restore an old open board on app start. This stops the board from appearing on Gym/Home/etc.
    GM_setValue(K_OPEN, false);
    APP.open = false;

    pageMount("boot");
    if (GM_getValue(K_API_KEY, "")) setTimeout(() => refreshHeaderCoinBadge(true), 2200);

    // PDA-safe faction/profile retry: short and limited. No heavy MutationObserver loop.
    mountTries = 0;
    const limitedRetry = setInterval(() => {
      mountTries += 1;
      pageMount("limited-retry");
      if (mountTries >= 8) clearInterval(limitedRetry);
    }, 1600);

    // Very light refresh only on pages where the app is visible/open.
    setInterval(() => {
      if (!isTornPage()) return;
      clearBankerUiOnWrongPage();

      pageMount("slow");

      if (GM_getValue(K_API_KEY, "") && !APP.open && Date.now() - (APP.lastHeaderBadgeLoad || 0) > 90000) {
        refreshHeaderCoinBadge(false);
      }
      if (GM_getValue(K_API_KEY, "") && APP.open && Date.now() - APP.lastLoad > 90000) {
        refreshAll(false);
      }
      if (GM_getValue(K_API_KEY, "") && isOwnFactionPage() && !APP.open && Date.now() - (APP.lastQuickLoad || 0) > 120000) {
        refreshFactionBoxData(false);
      }
    }, 30000);
  }

  function startWhenReady() {
    if (!isTornPage()) return;
    boot();
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
      mountTries = 0;
      scheduleMount("url");
      setTimeout(() => pageMount("url-retry-1"), 1600);
      setTimeout(() => pageMount("url-retry-2"), 3400);
    }
  }, 2500);

  // Prefill only on faction banking page and only a few times. This prevents PDA freezing.
  if (isFactionPage()) {
    setTimeout(() => { handleIncomingBankRequestUrl(); tryPrefillFactionBankForm(); startBalanceCaptureLoop(); }, 1000);
    setTimeout(tryPrefillFactionBankForm, 2600);
  }
})();
