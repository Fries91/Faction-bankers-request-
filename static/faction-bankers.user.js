// ==UserScript==
// @name         Torn Faction Bankers 🪙 
// @namespace    Fries91.Torn.FactionBankers.
// @version      1.3.8
// @description  Faction vault banking with strict /banker chat commands, banker board, leader role setup, and Torn-friendly settings/login.
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
  const FB_BUILD = "1.3.8-dashboard-remake";

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

  async function fbGetRequestListSafe() {
    try {
      return await gmRequest("GET", "/api/banker/requests");
    } catch (firstErr) {
      try {
        const lite = await gmRequest("GET", "/api/banker/requests-lite");
        lite._fallback_used = true;
        lite._first_error = String(firstErr?.message || firstErr || "");
        return lite;
      } catch (secondErr) {
        throw firstErr || secondErr;
      }
    }
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
        width: 23px !important;
        height: 23px !important;
        min-width: 23px !important;
        margin: 0 2px !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 4px !important;
        background: transparent !important;
        color: #ffd36a !important;
        font-size: 15px !important;
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
        transform: none !important;
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
        background: transparent !important;
        border-radius: 4px !important;
        box-shadow: 0 0 5px rgba(255,0,0,.55) !important;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.9)) saturate(1.1) brightness(1.02) !important;
      }

      #fb-bank-coin-clean.fb-alert::after {
        content: attr(data-count);
        position: absolute;
        top: -5px;
        right: -5px;
        min-width: 12px;
        height: 12px;
        padding: 0 3px;
        border-radius: 999px;
        background: #ff3131;
        color: #fff;
        font-size: 8px;
        font-weight: 900;
        line-height: 12px;
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
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 12px 0;
      }

      .fb-tab {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.055);
        color: #ddd;
        border-radius: 999px;
        padding: 9px 12px;
        font-size: 12px;
        cursor: pointer;
        font-weight: 900;
        min-height: 38px;
        min-width: 118px;
        flex: 1 1 118px;
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
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px 8px 0;
          overflow: visible;
        }

        .fb-tab {
          padding: 9px 10px;
          font-size: 12px;
          min-height: 39px;
          min-width: calc(50% - 6px);
          flex: 1 1 calc(50% - 6px);
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


      /* v1.1.3 vault theme cleanup */
      #fb-overlay,
      #fb-built-in-box {
        background:
          radial-gradient(circle at top left, rgba(255, 211, 106, .16), transparent 32%),
          linear-gradient(180deg, rgba(20,18,13,.98), rgba(4,4,4,.98)) !important;
        border-color: rgba(255,211,106,.42) !important;
        box-shadow: 0 18px 48px rgba(0,0,0,.65), inset 0 0 0 1px rgba(255,255,255,.04) !important;
      }

      #fb-head,
      .fb-built-head {
        background: linear-gradient(90deg, rgba(255,211,106,.09), rgba(0,0,0,.15)) !important;
      }

      .fb-tab {
        min-width: 106px !important;
        text-align: center !important;
        justify-content: center !important;
      }

      .fb-notify-card {
        border: 1px solid rgba(255,211,106,.34);
        background: linear-gradient(180deg, rgba(255,211,106,.12), rgba(255,211,106,.035));
        border-radius: 12px;
        padding: 10px 11px;
        color: #f7e7b6;
        font-size: 12px;
        line-height: 1.35;
        box-shadow: inset 0 0 18px rgba(255,211,106,.045);
      }

      .fb-notify-card b {
        display: block;
        color: #ffd36a;
        font-size: 13px;
        margin-bottom: 2px;
      }

      .fb-built-grid {
        grid-template-columns: 1fr 1fr !important;
        align-items: stretch !important;
      }

      .fb-built-grid .fb-wide,
      .fb-built-grid .fb-notify-card,
      .fb-built-grid .fb-own-faction,
      .fb-built-grid .fb-balance-line {
        grid-column: 1 / -1 !important;
      }

      #fb-built-amount,
      #fb-built-send,
      #fb-built-full,
      #fb-built-open-balance,
      #fb-built-refresh-balance,
      #fb-built-manual-balance {
        min-height: 42px !important;
      }

      @media (max-width: 520px) {
        .fb-built-grid {
          grid-template-columns: 1fr 1fr !important;
        }
        #fb-built-full,
        .fb-built-grid .fb-wide,
        .fb-built-grid .fb-notify-card,
        .fb-built-grid .fb-own-faction,
        .fb-built-grid .fb-balance-line {
          grid-column: 1 / -1 !important;
        }
        #fb-overlay .fb-tabs {
          display: grid !important;
          grid-template-columns: 1fr 1fr 1fr !important;
          gap: 7px !important;
        }
        #fb-overlay .fb-tab {
          min-width: 0 !important;
          padding: 9px 6px !important;
          font-size: 12px !important;
        }
      }



      /* v1.1.4 cleanup: keep board clean and stop the faction box from sitting behind the board */

      /* v1.2.9 command-only: no faction-page request box. Requests are /banker chat commands only. */
      #fb-built-in-box { display: none !important; }
      body.fb-board-open #fb-built-in-box {
        display: none !important;
      }

      #fb-overlay.fb-show {
        max-height: min(72vh, 620px) !important;
      }

      @media (max-width: 520px) {
        #fb-overlay.fb-show {
          top: auto !important;
          bottom: 74px !important;
          left: 8px !important;
          right: 8px !important;
          width: auto !important;
          max-height: 58vh !important;
          border-radius: 16px !important;
        }
        #fb-head {
          padding: 8px 10px !important;
        }
        #fb-body {
          padding: 8px !important;
        }
        .fb-box {
          padding: 9px !important;
          margin-bottom: 7px !important;
        }
      }

      .fb-notify-card {
        display: none !important;
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

      const html = String(el.innerHTML || "").toLowerCase();
      return text.includes("♂") || text.includes("♀") || cls.includes("gender") || title.includes("gender") || alt.includes("gender") || html.includes("male") || html.includes("female");
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

  function openRequestOverlayFromHeader(reason = "header") {
    // Used while flying/abroad: Torn faction page may be blocked/limited,
    // so the header coin opens the request tab directly instead of navigating.
    openOverlay();

    setTimeout(() => {
      const tab = document.querySelector('.fb-tab[data-tab="request"]');
      if (tab) tab.click();
      const subtitle = document.querySelector('#fb-subtitle');
      if (subtitle && reason) subtitle.textContent = reason;
    }, 140);
  }

  function profileLooksTravelingOrAbroad(data) {
    if (!data || typeof data !== "object") return false;

    const bits = [];
    const status = data.status;
    const travel = data.travel;
    const locationObj = data.location;

    if (status && typeof status === "object") {
      bits.push(status.state, status.details, status.description, status.color);
    } else if (status) {
      bits.push(status);
    }

    if (travel && typeof travel === "object") {
      bits.push(
        travel.status, travel.state, travel.phase, travel.destination, travel.departure,
        travel.method, travel.country, travel.city, travel.location
      );
    } else if (travel) {
      bits.push(travel);
    }

    if (locationObj && typeof locationObj === "object") {
      bits.push(locationObj.country, locationObj.city, locationObj.name);
    } else if (locationObj) {
      bits.push(locationObj);
    }

    const joined = bits.filter(Boolean).join(" ").toLowerCase();

    // Prioritize states that mean the user should not be pushed to faction page.
    if (/travel|travelling|flight|flying|returning|airborne|abroad|overseas/.test(joined)) return true;

    // Some Torn responses only expose a non-Torn location while abroad.
    // Treat common country/city location data as abroad unless it says Torn.
    const loc = String((locationObj && (locationObj.country || locationObj.city || locationObj.name)) || "").toLowerCase();
    if (loc && loc !== "torn" && !loc.includes("torn")) return true;

    return false;
  }

  function tornProfileForCurrentUser() {
    const key = GM_getValue(K_API_KEY, "");
    if (!key) return Promise.resolve(null);

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}`,
        timeout: 12000,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText || "{}");
            resolve(data && !data.error ? data : null);
          } catch {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  function pageLooksTravelingOrAbroad() {
    const href = String(location.href || "").toLowerCase();
    const title = String(document.title || "").toLowerCase();
    const bodyText = String(document.body?.innerText || "").toLowerCase().slice(0, 5000);

    if (/travel|travelagency|abroad|loader\.php\?sid=travel/.test(href)) return true;
    if (/travel|abroad|flight/.test(title)) return true;

    // Only use a small text sample to avoid expensive page scanning on PDA.
    if (/you are currently abroad|you are traveling|you are travelling|returning to torn|flying to|traveling to|travelling to/.test(bodyText)) {
      return true;
    }

    return false;
  }

  async function shouldHeaderCoinOpenRequestInsteadOfFaction() {
    if (pageLooksTravelingOrAbroad()) return true;

    const data = await tornProfileForCurrentUser();
    return profileLooksTravelingOrAbroad(data);
  }

  function maybeScrollToBankingBox() {
    if (!GM_getValue(K_SCROLL_TO_BANK, false)) return;
    if (!isOwnFactionPage()) return;
    if (scrollToFactionBankingBox()) GM_setValue(K_SCROLL_TO_BANK, false);
  }

  async function openHeaderCoinBoard() {
    // Coin is visible to everyone. New users land on Settings/Login.
    try {
      if (!APP.me && GM_getValue(K_API_KEY, "")) {
        gmRequest("GET", "/api/banker/me").then((me) => {
          APP.me = me;
          if (APP.open) {
            rebuildTabs(defaultTabForMe());
            renderBody(defaultTabForMe());
          }
        }).catch(() => {});
      }
    } catch {}

    openOverlay();
    setTimeout(() => {
      const tabName = defaultTabForMe();
      rebuildTabs(tabName);
      const tab = document.querySelector(`.fb-tab[data-tab="${tabName}"]`);
      if (tab) tab.click();
      else renderBody(tabName);
    }, 120);
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


  function findGlobalHeaderGenderTarget() {
    const nodes = Array.from(document.querySelectorAll("a, button, div, span, li, i, img, svg"));
    const candidates = [];

    for (const el of nodes) {
      if (!el || el.id === "fb-bank-coin-clean" || el.closest?.("#fb-overlay") || el.closest?.("#fb-built-in-box")) continue;
      const r = visibleRect(el);
      if (!r) continue;
      if (r.top < 0 || r.top > Math.max(650, window.innerHeight * 0.62)) continue;
      if (r.width > 70 || r.height > 70 || r.width < 8 || r.height < 8) continue;

      const text = getCleanText(el);
      const hay = [
        text,
        String(el.className || ""),
        String(el.id || ""),
        String(el.getAttribute("title") || ""),
        String(el.getAttribute("alt") || ""),
        String(el.getAttribute("aria-label") || ""),
        String(el.innerHTML || "").slice(0, 150),
      ].join(" ").toLowerCase();

      const genderHit = text.includes("♂") || text.includes("♀") || hay.includes("gender") || hay.includes("male") || hay.includes("female") || hay.includes("&male") || hay.includes("&female");
      if (!genderHit) continue;

      // Prefer the resource/icon row area, not profile text or overlay text.
      const score =
        (text.includes("♂") || text.includes("♀") ? 120 : 0) +
        (hay.includes("gender") ? 90 : 0) +
        (r.left > window.innerWidth * 0.25 ? 25 : 0) -
        Math.abs(r.height - 24) -
        Math.abs(r.width - 24);
      candidates.push({ el, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function mountCoin() {
    if (!isTornPage()) return;

    // Header-only coin. No profile coin, no floating fallback, no random page placement.
    const coin = makeHeaderCoin();
    coin.classList.remove("fb-fixed-test", "fb-header-fallback");
    coin.classList.add("fb-fixed-header", "fb-banker-visible");

    const globalGender = findGlobalHeaderGenderTarget();
    if (globalGender && globalGender.parentElement) {
      if (coin.parentElement !== globalGender.parentElement || coin.previousElementSibling !== globalGender) {
        globalGender.insertAdjacentElement("afterend", coin);
      }
      setCoinAlert(APP.pendingCount || 0);
      return;
    }

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
    // v1.2.9 command-only mode with guarded chat send: no faction-page request box.
    const oldBox = document.querySelector("#fb-built-in-box");
    if (oldBox) oldBox.remove();
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

      <div class="fb-tabs" id="fb-tabs"></div>

      <div id="fb-body"></div>
    `;

    document.body.appendChild(overlay);

    $("#fb-close").addEventListener("click", closeOverlay);

    rebuildTabs(defaultTabForMe());
  }

  function openOverlay() {
    APP.open = true;
    GM_setValue(K_OPEN, true);
    ensureOverlay();
    document.body.classList.add("fb-board-open");
    $("#fb-overlay").classList.add("fb-show");
    refreshAll(true);
  }

  function closeOverlay() {
    APP.open = false;
    GM_setValue(K_OPEN, false);
    document.body.classList.remove("fb-board-open");
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

  function isLeaderUiUser() {
    return !!(APP.me?.can_manage_leaders || APP.me?.is_leader_role || APP.me?.is_admin);
  }

  function isBankerUiUser() {
    return !!(APP.me?.is_banker || APP.me?.is_admin || isLeaderUiUser());
  }

  function allowedTabsForMe() {
    const hasKey = !!GM_getValue(K_API_KEY, "");
    if (!hasKey || !APP.me) {
      return [{ id: "settings", label: "Settings / Login" }];
    }

    if (isLeaderUiUser()) {
      return [
        { id: "banker", label: "Banking" },
        { id: "completed", label: "Completed" },
        { id: "bankers", label: "Bankers" },
        { id: "roles", label: "Roles" },
        { id: "settings", label: "Settings" },
      ];
    }

    if (isBankerUiUser()) {
      return [
        { id: "banker", label: "Banking" },
        { id: "completed", label: "Completed" },
        { id: "commands", label: "Commands" },
        { id: "balance", label: "Balance" },
        { id: "settings", label: "Settings" },
      ];
    }

    return [
      { id: "commands", label: "Commands" },
      { id: "balance", label: "Balance" },
      { id: "settings", label: "Settings" },
    ];
  }

  function defaultTabForMe() {
    const hasKey = !!GM_getValue(K_API_KEY, "");
    if (!hasKey || !APP.me) return "settings";
    if (isBankerUiUser() || isLeaderUiUser()) return "banker";
    return "commands";
  }

  function isTabAllowed(tab) {
    return allowedTabsForMe().some((t) => t.id === tab);
  }

  function rebuildTabs(preferredTab = "") {
    ensureOverlay();
    const wrap = $("#fb-tabs");
    if (!wrap) return;

    const tabs = allowedTabsForMe();
    const active = tabs.some((t) => t.id === preferredTab) ? preferredTab : defaultTabForMe();

    wrap.innerHTML = tabs.map((t) => `
      <button class="fb-tab ${t.id === active ? "active" : ""}" data-tab="${esc(t.id)}" type="button">${esc(t.label)}</button>
    `).join("");

    $$(".fb-tab", wrap).forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".fb-tab", wrap).forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderBody(btn.dataset.tab);
      });
    });
  }

  function activeTab() {
    const btn = $(".fb-tab.active");
    const tab = btn?.dataset?.tab || defaultTabForMe();
    return isTabAllowed(tab) ? tab : defaultTabForMe();
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
      complete: "Complete",
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

    let anyLabel = "All faction bankers";
    if (bankers.length) {
      const bits = [];
      if (onlineCount) bits.push(`${onlineCount} online`);
      if (travelingCount) bits.push(`${travelingCount} travel/abroad`);
      if (offlineCount) bits.push(`${offlineCount} unavailable`);
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
      const details = String(b.details || b.raw_details || "");
      const c = String(b.color || b.status_color || "").toLowerCase();
      const available = b.is_available || c === "green" ? "🟢" : (c === "yellow" || c === "blue" ? "🟡" : "🔴");
      const phoneText = friesPhoneText(b);
      const extra = details && details.toLowerCase() !== label.toLowerCase() ? ` (${esc(details).slice(0, 30)})` : "";
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
    APP.bankers = [];
    if (rerender && APP.open) renderBody(activeTab());
    mountBuiltInBankerBox();
  }

  function renderBody(tab = activeTab()) {
    ensureOverlay();

    if (!GM_getValue(K_API_KEY, "")) {
      rebuildTabs("settings");
      renderSettings("Add your Torn limited API key first.");
      return;
    }

    if (!APP.me) {
      rebuildTabs("settings");
      renderSettings("Saved key found. Tap Test Login at the bottom to verify your Torn account.");
      return;
    }

    if (!isTabAllowed(tab)) tab = defaultTabForMe();
    rebuildTabs(tab);

    if (tab === "commands" || tab === "request") renderCommandsTab();
    if (tab === "balance") renderBalanceTab();
    if (tab === "my") renderMyTab();
    if (tab === "banker") renderBankerTab();
    if (tab === "completed") renderCompletedTab();
    if (tab === "bankers") renderBankersManageTab();
    if (tab === "roles") renderRolesManageTab();
    if (tab === "leaders") renderLeadersTab();
    if (tab === "settings") renderSettings();
  }

  function renderBalanceTab(msg = "") {
    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}
      <div class="fb-box">
        <div class="fb-row fb-space">
          <div>
            <div class="fb-request-title">🪙 Balance Sync</div>
            <div class="fb-small">Sync or enter your faction bank balance so <code>/banker full</code> and your balance display work better.</div>
          </div>
          <span class="fb-pill">User Balance</span>
        </div>

        <div style="margin-top:12px;">${balanceLineHtml()}</div>

        <div class="fb-grid" style="margin-top:12px;">
          <button id="fb-balance-sync-tab" class="fb-btn blue" type="button">Sync Balance</button>
          <button id="fb-balance-refresh-tab" class="fb-btn" type="button">Refresh</button>
        </div>

        <div class="fb-small" style="margin-top:12px;">Manual balance</div>
        <div class="fb-grid" style="margin-top:8px;">
          <input id="fb-balance-manual-input" class="fb-input" placeholder="Example: 25m or 25000000" value="">
          <button id="fb-balance-manual-save" class="fb-btn gold" type="button">Save Balance</button>
        </div>

        <div class="fb-small" style="margin-top:12px; line-height:1.45;">
          Tip: Torn does not always expose balance cleanly from every page or while travelling.
          Use manual balance when sync cannot read it. The script stores it locally on your device.
        </div>
      </div>
    `);

    $("#fb-balance-sync-tab")?.addEventListener("click", async () => {
      showPayNotice("🪙 Syncing faction balance...");
      const ok = await loadFactionBalance(true);
      renderBalanceTab(ok ? "Balance sync finished." : "Balance sync failed. Try opening the faction balance page or enter it manually.");
    });

    $("#fb-balance-refresh-tab")?.addEventListener("click", async () => {
      await loadFactionBalance(true);
      renderBalanceTab("Balance refreshed.");
    });

    $("#fb-balance-manual-save")?.addEventListener("click", () => {
      const raw = $("#fb-balance-manual-input")?.value || "";
      const amount = fbParseBankerAmountToken(raw);
      if (!amount || amount <= 0) {
        showPayNotice("Enter a valid balance like 25m or 25000000.");
        return;
      }
      setFactionBalance(amount, "manual");
      GM_setValue(K_MANUAL_BALANCE_AMOUNT, String(amount));
      GM_setValue(K_MANUAL_BALANCE_TEXT, money(amount));
      showPayNotice(`🪙 Balance saved: ${money(amount)}`);
      renderBalanceTab("Manual balance saved.");
    });
  }

  function pendingRequests() {
    return (APP.requests || []).filter((r) => String(r.status || "pending").toLowerCase() === "pending");
  }

  function completedRequests() {
    return (APP.requests || [])
      .filter((r) => String(r.status || "").toLowerCase() === "complete")
      .slice(0, 5);
  }

  function copyTextToClipboard(text) {
    try {
      navigator.clipboard?.writeText(text);
      showPayNotice(`Copied: ${text}`);
    } catch (_) {
      showPayNotice(text);
    }
  }

  function renderCompletedTab(msg = "") {
    const completed = completedRequests();
    const cards = completed.length
      ? completed.map(requestCard).join("")
      : `<div class="fb-empty">No completed payouts yet. Completed requests will show here so bankers do not double-pay.</div>`;

    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}
      <div class="fb-box">
        <div class="fb-section-head">
          <div>
            <div class="fb-dashboard-title">Recently Completed</div>
            <div class="fb-dashboard-sub">Last 5 completed payouts. Use this to avoid double-paying someone.</div>
          </div>
          <button id="fb-completed-refresh" class="fb-btn" type="button">Refresh</button>
        </div>
      </div>
      ${cards}
    `);

    $("#fb-completed-refresh")?.addEventListener("click", () => refreshAll(true));
  }

  function renderBankersManageTab(msg = "") {
    renderLeadersTab(msg, "bankers");
  }

  function renderRolesManageTab(msg = "") {
    renderLeadersTab(msg, "roles");
  }

  function renderCommandsTab(msg = "") {
    const cards = [
      ["/banker 25m", "Request $25,000,000 from faction bank."],
      ["/banker 10m war meds", "Request with a note so bankers know why."],
      ["/banker full", "Request your full saved/synced balance."],
      ["/banker status", "Check your latest request."],
      ["/banker cancel", "Cancel your latest pending request."],
      ["/banker change 50m", "Change your latest pending request."]
    ];

    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}
      <div class="fb-box fb-hero-card">
        <div class="fb-dashboard-title">🪙 Chat Command Banking</div>
        <div class="fb-dashboard-sub">Type commands in faction chat. The script catches them, alerts bankers, and keeps requests out of public chat when possible.</div>
      </div>

      ${cards.map(([cmd, desc]) => `
        <div class="fb-command-card">
          <div class="fb-row fb-space">
            <div>
              <code>${esc(cmd)}</code>
              <div class="fb-small" style="margin-top:6px;">${esc(desc)}</div>
            </div>
            <button class="fb-btn gold" data-copy-command="${esc(cmd)}" type="button">Copy</button>
          </div>
        </div>
      `).join("")}

      <div class="fb-box">
        <div class="fb-request-title">How it flows</div>
        <div class="fb-small" style="line-height:1.55;margin-top:8px;">
          Member types command → request is saved → faction bankers are alerted → banker pays → banker marks complete.
        </div>
      </div>
    `);

    $$("[data-copy-command]").forEach((btn) => {
      btn.addEventListener("click", () => copyTextToClipboard(btn.getAttribute("data-copy-command") || ""));
    });
  }

  function renderRequestTab(msg = "") {
    renderCommandsTab(msg);
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

    $$("[data-fb-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => cancelMyRequest(btn.dataset.id));
    });
  }


  async function cancelMyRequest(id) {
    if (APP.busy || !id) return;
    const item = (APP.requests || []).find((r) => String(r.id) === String(id));
    if (!item) return;

    const ok = confirm("Remove this bank request? Bankers will no longer see it as pending.");
    if (!ok) return;

    APP.busy = true;
    try {
      await gmRequest("POST", `/api/banker/requests/${encodeURIComponent(id)}/cancel`, { note: "Canceled by requester" });
      rememberClosedRequest(id);
      clearLocalRequest(id);
      APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
      await refreshHeaderCoinBadge(true);
      renderMyTab();
      const body = $("#fb-body");
      if (body) body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-success">Request #${esc(id)} removed.</div></div>`);
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/not found|already|404/i.test(msg)) {
        rememberClosedRequest(id);
        clearLocalRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        renderMyTab();
        return;
      }
      renderMyTab();
      const body = $("#fb-body");
      if (body) body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-error">Could not remove request: ${esc(msg.slice(0, 120))}</div></div>`);
    } finally {
      APP.busy = false;
    }
  }

  function renderBankerTab(msg = "") {
    const pending = pendingRequests();
    const completed = completedRequests();

    const cards = pending.length
      ? pending.map(requestCard).join("")
      : `<div class="fb-empty">No pending bank requests right now. The vault may rest.</div>`;

    setBody(`
      ${msg ? `<div class="fb-box">${msg}</div>` : ""}
      <div class="fb-box fb-hero-card">
        <div class="fb-section-head">
          <div>
            <div class="fb-dashboard-title">Banker Board</div>
            <div class="fb-dashboard-sub">Pending requests only. Pay in Torn, then mark complete so other bankers do not double-pay.</div>
          </div>
          <button id="fb-refresh-bank" class="fb-btn" type="button">Refresh</button>
        </div>
        <div class="fb-stat-row">
          <div class="fb-stat-card"><b>${pending.length}</b><span>Pending</span></div>
          <div class="fb-stat-card"><b>${completed.length}</b><span>Recent completed</span></div>
        </div>
      </div>
      ${cards}
    `);

    $("#fb-refresh-bank")?.addEventListener("click", () => refreshAll(true));
    attachRequestButtons();
  }

  function attachRequestButtons() {
    $$("[data-fb-action]").forEach((btn) => {
      btn.addEventListener("click", () => bankerAction(btn.dataset.id, btn.dataset.fbAction));
    });
    $$("[data-fb-pay]").forEach((btn) => {
      btn.addEventListener("click", () => openBankPageForRequest(btn.dataset.id));
    });
    $$("[data-fb-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => cancelOwnRequest(btn.dataset.id));
    });
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

      const isCompleteAction = ["paid", "complete", "mark_paid", "mark_complete"].includes(String(action || "").toLowerCase());
      const label = isCompleteAction ? "completed" : action === "deny" ? "denied" : "approved";

      // Important: completed requests should NOT be hidden locally. Bankers need
      // to see who completed it so nobody double-pays. Deny/cancel can still hide.
      if (isCompleteAction) {
        forgetClosedRequest(id);
        clearLocalRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
        if (res && res.item) APP.requests.unshift(res.item);
      } else {
        rememberClosedRequest(id);
        APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(id));
      }

      await refreshAll(true);

      if (activeTab() === "banker") {
        renderBankerTab();
        const body = $("#fb-body");
        if (body) {
          const who = res?.item?.handled_by_name ? ` by ${esc(res.item.handled_by_name)}` : "";
          body.insertAdjacentHTML("afterbegin", `<div class="fb-box"><div class="fb-success">Request #${esc(id)} ${esc(label)}${who}. Other bankers can see this in Recently Completed.</div></div>`);
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
    const saveToKey = (key) => {
      try {
        const raw = GM_getValue(key, "[]");
        const arr = JSON.parse(raw);
        const current = Array.isArray(arr) ? arr : [];
        const mine = current
          .filter((r) => r && String(r.id) !== String(item.id))
          .filter((r) => !r._local_saved_at || now - Number(r._local_saved_at) < 1000 * 60 * 60 * 24 * 2);
        mine.unshift({ ...item, _local_saved_at: now, _local_backup: true });
        GM_setValue(key, JSON.stringify(mine.slice(0, 20)));
      } catch (_) {}
    };
    saveToKey(localRequestKey());
    const requesterKey = `fb_local_requests_v1_${item.requester_id || item.player_id || APP.me?.player_id || "guest"}`;
    saveToKey(requesterKey);
  }

  function saveRecentCreatedRequest(item) {
    if (!item || !item.id) return;
    try {
      GM_setValue("fb_recent_created_request_v1", JSON.stringify({ ...item, _local_saved_at: Date.now(), _local_backup: true }));
    } catch (_) {}
  }

  function getRecentCreatedRequest() {
    try {
      const raw = GM_getValue("fb_recent_created_request_v1", "");
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (!item || !item.id) return null;
      if (Date.now() - Number(item._local_saved_at || 0) > 1000 * 60 * 30) return null;
      if (getClosedRequestIds().includes(String(item.id))) return null;
      return item;
    } catch (_) {
      return null;
    }
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

  function forgetClosedRequest(id) {
    if (!id) return;
    const sid = String(id);
    const nextLocal = readClosedIdsFromKey(closedRequestKey()).filter((x) => String(x) !== sid);
    const nextGlobal = readClosedIdsFromKey(closedRequestGlobalKey()).filter((x) => String(x) !== sid);
    GM_setValue(closedRequestKey(), JSON.stringify(nextLocal.slice(0, 120)));
    GM_setValue(closedRequestGlobalKey(), JSON.stringify(nextGlobal.slice(0, 120)));
  }

  function clearLocalRequest(id) {
    if (!id) return;
    const keep = getLocalRequests().filter((r) => String(r?.id) !== String(id));
    GM_setValue(localRequestKey(), JSON.stringify(keep.slice(0, 20)));
  }

  function mergeLocalRequests(items) {
    const closed = new Set(getClosedRequestIds());
    const list = (Array.isArray(items) ? items.slice() : []).filter((r) => {
      const status = String(r?.status || "pending").toLowerCase();
      if (status === "complete") return true;
      return !closed.has(String(r?.id));
    });
    const ids = new Set(list.map((r) => String(r.id)));
    const recent = getRecentCreatedRequest();
    if (recent && recent.id && !closed.has(String(recent.id)) && !ids.has(String(recent.id))) {
      list.unshift(recent);
      ids.add(String(recent.id));
    }

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

      APP.bankers = [];
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

      const list = await fbGetRequestListSafe();
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
      if (APP.open) rebuildTabs(activeTab());

      await loadFactionBalance(false);

      if (APP.me?.can_manage_leaders || APP.me?.is_admin || APP.me?.is_banker) {
        await loadLeaderBankers();
      }

      const list = await fbGetRequestListSafe();
      APP.requests = mergeLocalRequests(Array.isArray(list.items) ? list.items : []);

      APP.bankers = [];

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



  // v1.2.4: faction chat command banking, send-only intercept, and user remove request.
  // Handles both PC Enter and PDA/mobile send-button taps.
  function fbParseBankerAmountToken(token) {
    const raw = String(token || "").trim().toLowerCase().replace(/[$,]/g, "");
    if (!raw) return 0;
    const m = raw.match(/^(\d+(?:\.\d+)?)(k|m|b|mil|mill|million|bil|billion)?$/i);
    if (!m) return 0;
    let n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const suffix = String(m[2] || "").toLowerCase();
    if (suffix === "k") n *= 1000;
    if (["m", "mil", "mill", "million"].includes(suffix)) n *= 1000000;
    if (["b", "bil", "billion"].includes(suffix)) n *= 1000000000;
    return Math.floor(n);
  }


  function fbIsCompleteBankerCommandText(text) {
    const t = String(text || "").trim();
    if (!/^\/banker(\s|$)/i.test(t)) return false;
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return false;
    const action = String(parts[1] || "").toLowerCase();
    if (["help", "commands", "?", "status", "check", "mine", "cancel", "remove", "delete"].includes(action)) return true;
    if (["change", "edit", "update"].includes(action)) return parts.length >= 3;
    if (["full", "balance", "all", "max"].includes(action)) return true;
    return fbParseBankerAmountToken(action) > 0;
  }

  function fbGetEditableText(el) {
    if (!el) return "";
    if (el.isContentEditable) return String(el.innerText || el.textContent || "").trim();
    return String(el.value || "").trim();
  }

  function fbSetEditableText(el, value) {
    if (!el) return;
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    } else {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function fbLikelyChatInput(el) {
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.getAttribute("type") || "").toLowerCase();
    const cls = String(el.className || "").toLowerCase();
    const ph = String(el.getAttribute("placeholder") || "").toLowerCase();
    const aria = String(el.getAttribute("aria-label") || "").toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const editable = !!el.isContentEditable || tag === "textarea" || (tag === "input" && ["", "text", "search"].includes(type));
    if (!editable) return false;
    const text = fbGetEditableText(el);
    if (String(text || "").trim().toLowerCase().startsWith("/banker")) return true;
    const hint = `${cls} ${ph} ${aria} ${role}`;
    return hint.includes("chat") || hint.includes("message") || hint.includes("send") || location.href.includes("/messages.php") || !!document.querySelector('[class*="chat" i], [id*="chat" i]');
  }

  function fbFindBankerCommandInput() {
    const active = document.activeElement;
    if (active && fbLikelyChatInput(active) && fbIsCompleteBankerCommandText(fbGetEditableText(active))) return active;
    const inputs = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]'));
    return inputs.find((el) => fbLikelyChatInput(el) && fbIsCompleteBankerCommandText(fbGetEditableText(el))) || null;
  }

  let FB_CHAT_COMMAND_BUSY = false;
  let FB_CHAT_LAST_SENT = { text: "", ts: 0 };

  async function fbSendBankerChatCommand(commandText) {
    const text = String(commandText || "").trim();
    const now = Date.now();
    if (FB_CHAT_COMMAND_BUSY) return true;
    if (FB_CHAT_LAST_SENT.text === text && now - FB_CHAT_LAST_SENT.ts < 6000) return true;
    FB_CHAT_COMMAND_BUSY = true;
    FB_CHAT_LAST_SENT = { text, ts: now };
    setTimeout(() => { FB_CHAT_COMMAND_BUSY = false; }, 10000);

    const parts = text.split(/\s+/).filter(Boolean);
    const cmd = String(parts[0] || "").toLowerCase();
    const action = String(parts[1] || "help").toLowerCase();
    if (cmd !== "/banker") { FB_CHAT_COMMAND_BUSY = false; return false; }

    if (!GM_getValue(K_API_KEY, "")) {
      showPayNotice("Save your limited Torn API key in Factional Banking settings first.");
      openOverlay();
      setTimeout(() => document.querySelector('.fb-tab[data-tab="settings"]')?.click(), 120);
      FB_CHAT_COMMAND_BUSY = false;
      return true;
    }

    if (parts.length === 1) {
      // Do not open the overlay or send anything while the user is still typing "/banker".
      FB_CHAT_COMMAND_BUSY = false;
      return false;
    }

    if (["help", "commands", "?"].includes(action)) {
      showPayNotice("Commands: /banker 25m, /banker full, /banker status, /banker cancel, /banker change 50m");
      // Keep this as a toast only so typing /banker never pops the banking overlay open.
      FB_CHAT_COMMAND_BUSY = false;
      return true;
    }

    // For full balance, use an explicit full-balance marker.
    // If we know the user's balance, include it for optional bank-page prefill.
    // If unknown, send amount 0 so the board shows "Full Balance" instead of "$1".
    let amount = 0;
    const isFullCommand = ["full", "balance", "all", "max"].includes(action);
    if (isFullCommand) {
      await loadFactionBalance(true);
      const detected = Number(APP.balanceAmount || 0);
      amount = Number.isFinite(detected) && detected > 0 ? Math.floor(detected) : 0;
    } else if (!["cancel", "remove", "delete", "change", "edit", "update", "status", "check", "mine"].includes(action)) {
      amount = fbParseBankerAmountToken(action);
    }

    try {
      if (!APP.me) APP.me = await gmRequest("GET", "/api/banker/me");
      showPayNotice("🪙 Processing /banker command...");
      const res = await gmRequest("POST", "/api/banker/chat-command", { command_text: text, amount, request_kind: isFullCommand ? "full" : "amount" });

      if (res && res.item) {
        if (res.action === "canceled") {
          rememberClosedRequest(res.item.id);
          clearLocalRequest(res.item.id);
          APP.requests = (APP.requests || []).filter((r) => String(r.id) !== String(res.item.id));
        } else {
          upsertRequestItem(res.item);
          saveLocalRequest(res.item);
          saveRecentCreatedRequest(res.item);
          APP.requests = mergeLocalRequests([res.item, ...(Array.isArray(APP.requests) ? APP.requests : [])]);
          if (APP.me?.is_banker || APP.me?.is_admin) setCoinAlert(APP.requests.filter((r) => String(r.status || "pending").toLowerCase() === "pending").length);
          if (APP.open) renderBody(activeTab());
        }
      }

      // Do not let a slow/stale Render list erase the just-created request.
      // Refresh shortly after, but keep local backup merged if Render is late.
      setTimeout(() => refreshAll(true).catch(() => { if (APP.open) renderBody(activeTab()); }), 1800);
      setTimeout(() => refreshHeaderCoinBadge(true).catch(() => {}), 2200);

      const a = String(res?.action || "created");
      if (a === "created") {
        if (!isFullCommand && amount > 1) deductRequestedAmountFromLocalBalance(amount);
        const label = isFullCommand ? " for Full Balance" : (amount > 1 ? ` for ${money(amount)}` : "");
        showPayNotice(res?.pushover_sent === false ? "🪙 Request saved. Phone ping did not confirm, but bankers can check the board." : `🪙 Confirmed: bank request sent${label}. Bankers alerted.`);
      } else if (a === "canceled") {
        showPayNotice("🪙 Bank request canceled.");
      } else if (a === "changed") {
        showPayNotice(`🪙 Bank request changed to ${money(res.item.amount)}.`);
      } else if (a === "status") {
        if (res.item) showPayNotice(`🪙 Latest request #${res.item.id}: ${res.item.status} • ${money(res.item.amount)}`);
        else showPayNotice("🪙 No bank requests found.");
      } else if (a === "help") {
        showPayNotice(res.message || "Use /banker help for commands.");
      } else {
        showPayNotice("🪙 /banker command done.");
      }

      FB_CHAT_COMMAND_BUSY = false;
      return true;
    } catch (err) {
      showPayNotice(`Bank request failed: ${String(err.message || err).slice(0, 140)}`);
      FB_CHAT_COMMAND_BUSY = false;
      return true;
    }
  }

  function fbInterceptBankerCommandInput(el, ev) {
    if (!el || !fbLikelyChatInput(el)) return false;
    const text = fbGetEditableText(el);
    if (!String(text || "").trim().toLowerCase().startsWith("/banker")) return false;
    if (!fbIsCompleteBankerCommandText(text)) return false;

    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
    }

    FB_CHAT_LAST_TYPED_COMMAND = { text: String(text || "").trim(), ts: Date.now() };
    fbSetEditableText(el, "");
    try { el.blur?.(); } catch (_) {}
    fbSendBankerChatCommand(text);
    return true;
  }

  function installChatBankerCommand() {
    if (installChatBankerCommand._installed) return;
    installChatBankerCommand._installed = true;

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      fbInterceptBankerCommandInput(ev.target, ev);
    }, true);

    function fbIsActualChatSendTap(ev, target, inputEl) {
      if (!target || !inputEl || fbIsInsideOurBankerUi(target)) return false;

      const targetText = `${String(target.textContent || "").toLowerCase()} ${String(target.className || "").toLowerCase()} ${String(target.id || "").toLowerCase()} ${String(target.getAttribute?.("aria-label") || "").toLowerCase()} ${String(target.getAttribute?.("title") || "").toLowerCase()}`;
      const btn = target.closest && target.closest('button, [role="button"], input[type="submit"], a');
      const btnText = `${String(btn?.textContent || "").toLowerCase()} ${String(btn?.className || "").toLowerCase()} ${String(btn?.id || "").toLowerCase()} ${String(btn?.getAttribute?.("aria-label") || "").toLowerCase()} ${String(btn?.getAttribute?.("title") || "").toLowerCase()}`;

      // Text-labeled send buttons are okay. Do not match generic words like "message".
      if (/\b(send|submit|sendmessage|send-message)\b/.test(targetText + " " + btnText)) return true;

      let r1;
      try { r1 = inputEl.getBoundingClientRect(); } catch (_) { return false; }
      if (!r1 || !r1.width || !r1.height) return false;

      // PDA send arrow: pointer is directly to the right of the chat input on the same row.
      const touch = ev?.changedTouches?.[0] || ev?.touches?.[0] || null;
      const x = Number(ev?.clientX || touch?.clientX || 0);
      const y = Number(ev?.clientY || touch?.clientY || 0);
      if (x && y) {
        const rowY = y >= (r1.top - 22) && y <= (r1.bottom + 22);
        const rightOfInput = x >= (r1.right + 2) && x <= (r1.right + 150);
        if (rowY && rightOfInput) return true;
      }

      // Fallback for wrapped icon/button geometry.
      const clickEl = btn || target;
      try {
        const r2 = clickEl.getBoundingClientRect();
        const inputMidY = r1.top + r1.height / 2;
        const btnMidY = r2.top + r2.height / 2;
        const closeY = Math.abs(inputMidY - btnMidY) <= Math.max(55, r1.height * 1.15);
        const smallish = r2.width <= 120 && r2.height <= 120;
        const toRight = r2.left >= (r1.right - 2) && r2.left <= (r1.right + 150);
        return !!(closeY && smallish && toRight);
      } catch (_) {
        return false;
      }
    }

    const pointerHandler = (ev) => {
      const t = ev.target;
      if (t && t.closest && t.closest('#fb-board, #fb-built-in-box, #fb-header-coin, #fb-pay-prefill-notice')) return;
      const el = fbFindBankerCommandInput();
      if (!el) return;

      // Only the chat send button/arrow sends. Tapping the coin, chat history,
      // suggestions, or the input itself never sends.
      if (!fbIsActualChatSendTap(ev, t, el)) return;
      fbInterceptBankerCommandInput(el, ev);
    };

    document.addEventListener("pointerdown", pointerHandler, true);
    document.addEventListener("touchstart", pointerHandler, true);
    document.addEventListener("mousedown", pointerHandler, true);
    document.addEventListener("click", pointerHandler, true);

    document.addEventListener("submit", (ev) => {
      const el = fbFindBankerCommandInput();
      if (el) fbInterceptBankerCommandInput(el, ev);
    }, true);
  }

  // v1.2.5 reliable chat fallback:
  // PDA sometimes posts /banker as a normal message before our send-button hook sees it.
  // We remember the command while the user types, then if the exact same command appears
  // in the chat within a few seconds, we still create the request and ping bankers once.
  let FB_CHAT_LAST_TYPED_COMMAND = { text: "", ts: 0 };
  const FB_CHAT_FALLBACK_DONE = new Set();

  function fbRememberTypedBankerCommandFrom(el) {
    if (!el || !fbLikelyChatInput(el)) return;
    const text = String(fbGetEditableText(el) || "").trim();
    if (!fbIsCompleteBankerCommandText(text)) return;
    FB_CHAT_LAST_TYPED_COMMAND = { text, ts: Date.now() };
  }

  function fbIsInsideOurBankerUi(el) {
    try {
      return !!(el && el.closest && el.closest('#fb-board, #fb-built-in-box, #fb-header-coin, #fb-pay-prefill-notice'));
    } catch (_) { return false; }
  }

  function fbFindPostedBankerCommandText() {
    const remembered = String(FB_CHAT_LAST_TYPED_COMMAND.text || "").trim();
    if (!remembered || !fbIsCompleteBankerCommandText(remembered) || Date.now() - Number(FB_CHAT_LAST_TYPED_COMMAND.ts || 0) > 25000) return "";

    // Look for exact command text in visible chat/message nodes. Exact-match keeps this
    // from creating requests from other players' old /banker messages.
    const candidates = Array.from(document.querySelectorAll('div, span, p, li, button'));
    for (const el of candidates) {
      if (!el || fbIsInsideOurBankerUi(el)) continue;
      const tag = String(el.tagName || "").toLowerCase();
      if (["input", "textarea", "select", "option"].includes(tag) || el.isContentEditable) continue;
      const txt = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt === remembered) return remembered;
    }
    return "";
  }

  function installChatBankerCommandFallback() {
    if (installChatBankerCommandFallback._installed) return;
    installChatBankerCommandFallback._installed = true;

    document.addEventListener('input', (ev) => fbRememberTypedBankerCommandFrom(ev.target), true);
    document.addEventListener('keyup', (ev) => fbRememberTypedBankerCommandFrom(ev.target), true);

    // v1.3.2: disabled post-to-chat fallback.
    // The old fallback could fire from a visible /banker draft/message and ping before
    // the user intentionally pressed send. Commands now only run on Enter or the real
    // chat send button, and the script tries to prevent the command from posting.
    // This intentionally does nothing.
    return;
  }

  function startWhenReady() {
    if (!isTornPage()) return;
    installChatBankerCommand();
    installChatBankerCommandFallback();
    boot();
  }



  // v1.1.8 safe bank prefill override.
  // Older PDA/iPhone builds could get stuck repeatedly trying to click the player autocomplete.
  // This version only selects the player a couple of times, then targets Torn's real $ field without locking the page.
  let FB_PREFILL_LAST_PICK = 0;
  let FB_PREFILL_LAST_AMOUNT_OK = "";

  function fbVisibleRect(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 20 || r.height < 10) return null;
      if (r.bottom < 0 || r.top > window.innerHeight + 200) return null;
      return r;
    } catch { return null; }
  }

  function fbIsAutocompleteResult(el, data) {
    if (!el || el.closest?.("#fb-built-in-box, #fb-overlay, #fb-pay-prefill-notice")) return false;
    const r = fbVisibleRect(el);
    if (!r) return false;
    const txt = getCleanText(el).toLowerCase();
    const name = String(data?.playerName || "").toLowerCase();
    const id = String(data?.playerId || "");
    if (!txt || txt.length > 160) return false;
    if (id && !txt.includes(id)) return false;
    if (name && !txt.includes(name)) return false;
    if (["friends", "faction", "company", "all"].some((x) => txt.trim() === x)) return false;
    return true;
  }

  function fbClickPlayerResultOnce(data) {
    if (!data?.playerId) return false;
    const now = Date.now();
    if (now - FB_PREFILL_LAST_PICK < 1600) return false;
    FB_PREFILL_LAST_PICK = now;

    const candidates = Array.from(document.querySelectorAll("li, a, button, div, span"))
      .filter((el) => fbIsAutocompleteResult(el, data))
      .map((el) => {
        const txt = getCleanText(el).toLowerCase();
        const r = el.getBoundingClientRect();
        let score = 0;
        if (String(data.playerId) && txt.includes(String(data.playerId))) score += 200;
        if (String(data.playerName || "").toLowerCase() && txt.includes(String(data.playerName || "").toLowerCase())) score += 120;
        if (/\[[0-9]+\]/.test(txt)) score += 60;
        if (el.tagName === "LI") score += 60;
        if (el.tagName === "A" || el.tagName === "BUTTON") score += 35;
        // Prefer row-sized items, not giant wrappers.
        if (r.height >= 18 && r.height <= 70) score += 40;
        score -= Math.max(0, (r.width * r.height - 42000) / 1000);
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    const choice = candidates[0]?.el;
    if (!choice) return false;
    const ok = tapElementHard(choice);
    try { document.activeElement?.blur?.(); } catch {}
    try { document.body?.focus?.(); } catch {}
    return ok;
  }

  function fbFindRealDollarAmountInput(playerInput) {
    const own = "#fb-built-in-box, #fb-overlay, #fb-pay-prefill-notice";
    const usable = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
      .filter((el) => !el.closest?.(own))
      .filter((el) => visibleInput(el))
      .filter((el) => el !== playerInput)
      .filter((el) => el.isContentEditable || !String(el.type || "").match(/hidden|submit|button|checkbox|radio/i))
      .filter((el) => !looksLikePlayerInput(el));

    if (!usable.length) return null;

    const dollars = Array.from(document.querySelectorAll("div, span, label, b, strong, i"))
      .filter((el) => !el.closest?.(own))
      .filter((el) => /^\s*\$\s*$/.test(String(el.textContent || "")))
      .map((el) => el.getBoundingClientRect());

    const pr = playerInput?.getBoundingClientRect?.();
    const scored = usable.map((el) => {
      const r = el.getBoundingClientRect();
      let score = 5000;
      for (const d of dollars) {
        const sameRow = Math.abs((r.top + r.height / 2) - (d.top + d.height / 2));
        const rightGap = Math.abs(r.left - d.right);
        score = Math.min(score, sameRow * 10 + rightGap);
      }
      if (pr) {
        if (r.top > pr.bottom - 10 && r.top < pr.bottom + 210) score -= 900;
        if (Math.abs(r.left - pr.left) < 120) score -= 150;
      }
      const sig = inputSignature(el);
      if (sig.includes("amount") || sig.includes("money") || sig.includes("give")) score -= 350;
      if (sig.includes("search") || sig.includes("player") || sig.includes("member")) score += 1000;
      return { el, score };
    }).sort((a, b) => a.score - b.score);

    return scored[0]?.el || null;
  }

  function fbSafeFillAmount(data, playerInput) {
    const cleanAmount = String(data?.amount || "").replace(/[^0-9]/g, "");
    if (!cleanAmount) return false;
    const amountInput = fbFindRealDollarAmountInput(playerInput);
    if (!amountInput) return false;
    const ok = setNativeValue(amountInput, cleanAmount);
    try {
      amountInput.dispatchEvent(new Event("input", { bubbles: true }));
      amountInput.dispatchEvent(new Event("change", { bubbles: true }));
      amountInput.blur();
    } catch {}
    const current = String(amountInput.value || amountInput.textContent || "").replace(/[^0-9]/g, "");
    if (ok && current === cleanAmount) {
      FB_PREFILL_LAST_AMOUNT_OK = String(data.requestId || "") + ":" + cleanAmount;
      showPayNotice(`Bank prefill ready for ${data.playerName} [${data.playerId}] — $${Number(cleanAmount).toLocaleString()}. Manually press Give Money.`);
      return true;
    }
    return ok;
  }

  function tryPrefillFactionBankForm() {
    if (!isFactionPage()) return;
    const data = getPayPrefill();
    if (!data || !data.playerId) return;

    clickTextButton(["controls", "bank", "give money", "vault"]);

    const playerInput = bestInput("player");
    if (playerInput) {
      const wanted = `${data.playerName} [${data.playerId}]`;
      const existing = String(playerInput.value || playerInput.textContent || "");
      if (!existing.includes(String(data.playerId))) {
        setNativeValue(playerInput, wanted);
      }
      // Try to accept Torn autocomplete once/twice only. Repeated clicks were causing PDA lockups.
      fbClickPlayerResultOnce(data);
      setTimeout(() => fbClickPlayerResultOnce(data), 900);
      setTimeout(() => { try { playerInput.blur(); } catch {} }, 1200);
    }

    if (data.amount) {
      const token = String(data.requestId || "") + ":" + String(data.amount).replace(/[^0-9]/g, "");
      if (FB_PREFILL_LAST_AMOUNT_OK !== token) {
        [500, 1300, 2600, 4200, 6500].forEach((delay) => {
          setTimeout(() => {
            const p = bestInput("player") || playerInput;
            fbSafeFillAmount(data, p);
          }, delay);
        });
      }
    } else {
      showPayNotice(`Bank prefill ready for ${data.playerName} [${data.playerId}] — Full Balance request. Manually enter amount and press Give Money.`);
    }
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
