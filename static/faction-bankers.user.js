// ==UserScript==
// @name         Torn Faction Bankers 🪙 
// @namespace    Fries91.Torn.FactionBankers.
// @version      0.7.9
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
  const FB_BUILD = "0.7.9-pda-stable";

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
  const FULL_BALANCE_NOTE = "__FULL_BALANCE_REQUEST__";

  // PDA-safe fallback list.
  // This lets the dropdown still work even if Render is waking up or the new /api/banker/factions endpoint is not live yet.
  const DEFAULT_FACTIONS = [
    { faction_id: "52040", faction_name: "Sloth" },
    { faction_id: "20554", faction_name: "Pride" },
    { faction_id: "8315", faction_name: "Greed" },
    { faction_id: "49384", faction_name: "Wrath" },
  ];

  const APP = {
    me: null,
    factions: DEFAULT_FACTIONS.slice(),
    requests: [],
    bankers: [],
    bankerFactionId: "",
    bankerStatusError: "",
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
        display: inline-flex !important;
        position: fixed !important;
        right: 10px !important;
        bottom: 132px !important;
        z-index: 100001 !important;
        width: 36px !important;
        height: 34px !important;
        background: rgba(0,0,0,.78) !important;
        border-color: rgba(255,211,106,.65) !important;
        box-shadow: 0 5px 16px rgba(0,0,0,.55) !important;
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
    // No global floating coin. The user only wants:
    // 1) quick request box inside the own faction page
    // 2) small coin beside ABSP/BSP on profile pages for settings/login
    document.querySelectorAll("#fb-bank-coin, #fb-bank-coin-clean").forEach((oldCoin) => {
      oldCoin.style.display = "none";
      oldCoin.remove();
    });
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
    let coin = $("#fb-profile-bank-coin");

    if (!isProfilePage()) {
      if (coin) coin.remove();
      return;
    }

    const found = findAbspProfileIconTarget();
    if (!found || !found.target) {
      if (coin) coin.remove();
      return;
    }

    const target = found.target;

    if (!coin) {
      coin = document.createElement("button");
      coin.id = "fb-profile-bank-coin";
      coin.type = "button";
      coin.textContent = "🪙";
      coin.title = "Faction Bankers settings / login";
      coin.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openBankerSettings();
      });
    }

    coin.classList.remove("fb-profile-fallback");

    if (target.parentElement) {
      if (coin.parentElement !== target.parentElement || coin.previousElementSibling !== target) {
        target.insertAdjacentElement("afterend", coin);
      }
    }
  }

  function mountBuiltInBankerBox() {
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
    const selectedFaction = GM_getValue(K_TARGET_FACTION, "");
    const activeEl = document.activeElement;
    const userIsTyping = !!(box && activeEl && box.contains(activeEl) && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(activeEl.tagName));
    const renderSig = JSON.stringify({
      f: (APP.factions || []).map((x) => [String(x.faction_id || ""), String(x.faction_name || "")]),
      b: (APP.bankers || []).map((x) => [String(x.player_id || ""), String(x.name || ""), String(x.bucket || x.status_color || x.color || ""), String(x.status_text || x.status || x.label || "")]),
      err: APP.bankerStatusError || "",
      sf: selectedFaction,
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
        <select id="fb-built-faction" aria-label="Faction banker group">
          ${factionOptions(selectedFaction)}
        </select>
        <select id="fb-built-banker" aria-label="Choose available banker">
          ${bankerOptions()}
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
    $("#fb-built-faction")?.addEventListener("change", () => handleFactionChangeAndReload("#fb-built-faction", false));
    $("#fb-built-send")?.addEventListener("click", submitBuiltInRequest);
    $("#fb-built-full")?.addEventListener("click", submitFullBalanceRequest);

    setCoinAlert(APP.pendingCount || 0);
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
    const coin = $("#fb-bank-coin-clean");
    const setupBtn = $("#fb-setup-button");
    const n = Number(count || 0);
    const hasKey = !!GM_getValue(K_API_KEY, "");
    const canBank = !!(APP.me?.is_banker || APP.me?.is_admin);
    APP.pendingCount = n;

    if (coin) {
      coin.setAttribute("data-count", String(n > 99 ? "99+" : n));

      // Always show the coin so members can open the app and send requests.
      coin.classList.add("fb-banker-visible", "fb-fixed-test");

      if (canBank && n > 0) {
        coin.classList.add("fb-alert");
        coin.title = `${n} pending faction bank request${n === 1 ? "" : "s"} — tap to pay members`;
      } else {
        coin.classList.remove("fb-alert");
        coin.title = hasKey ? "Faction Bankers" : "Faction Bankers setup";
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
    const items = Array.isArray(APP.factions) && APP.factions.length ? APP.factions : DEFAULT_FACTIONS;

    return [
      `<option value="">Choose faction banker group</option>`,
      ...items.map((f) => {
        const id = String(f.faction_id || "");
        const name = String(f.faction_name || id);
        return `<option value="${esc(id)}" ${String(selected) === id ? "selected" : ""}>${esc(name)}</option>`;
      }),
    ].join("");
  }

  function rememberFactionFromSelect(sel) {
    const val = $(sel)?.value || "";
    if (val) GM_setValue(K_TARGET_FACTION, val);
    return val;
  }

  function selectedFactionFromPage() {
    return (
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

  function currentTargetFactionId() {
    return (
      $("#fb-target-faction")?.value ||
      $("#fb-built-faction")?.value ||
      GM_getValue(K_TARGET_FACTION, "") ||
      APP.me?.faction_id ||
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
      APP.bankers = Array.isArray(res.items) ? res.items : [];
      APP.bankerFactionId = fid;
      APP.bankerStatusError = APP.bankers.length ? "" : "No bankers returned by Render for this faction.";
      return true;
    } catch (err) {
      // Keep the last good list so the request box does not flicker/disappear on PDA.
      APP.bankerFactionId = fid;
      APP.bankerStatusError = String(err?.message || err || "Banker status failed");
      if (!APP.bankers.length) {
        APP.bankers = [{
          player_id: "3679030",
          name: "Fries91",
          status: "unknown",
          color: "gray",
          label: "Status unavailable",
          details: APP.bankerStatusError,
          is_available: false,
        }];
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
    return isFries91Banker(b) ? " • pings directly to phone" : "";
  }

  function bankerOptions(selected = "") {
    const bankers = Array.isArray(APP.bankers) ? APP.bankers : [];
    const options = [`<option value="">Any available banker</option>`];

    for (const b of bankers) {
      const id = String(b.player_id || "");
      const name = String(b.name || id);
      const label = String(b.label || "Unknown");
      const details = String(b.details || "");
      const available = b.is_available ? "🟢" : (b.color === "yellow" || b.color === "blue" ? "🟡" : "🔴");
      const phoneText = friesPhoneText(b);
      options.push(`<option value="${esc(id)}" ${String(selected) === id ? "selected" : ""}>${available} ${esc(name)} — ${esc(label)}${phoneText}${details ? ` (${esc(details).slice(0, 42)})` : ""}</option>`);
    }

    return options.join("");
  }

  function bankerStatusPanel() {
    const bankers = Array.isArray(APP.bankers) ? APP.bankers : [];
    if (!bankers.length) {
      const msg = APP.bankerStatusError || "Banker status loading…";
      return `<div class="fb-small" style="margin-top:8px;">${esc(msg)}</div>`;
    }

    return `
      <div class="fb-bankers-list">
        ${bankers.map((b) => `
          <div class="fb-banker-line">
            <div class="fb-banker-main">
              <div class="fb-small"><span class="fb-dot ${esc(b.color || "gray")}"></span><b style="color:#fff;">${esc(b.name || b.player_id)}</b> ${esc(b.label || "Unknown")}<span style="color:#8dffac;font-weight:900;">${esc(friesPhoneText(b))}</span></div>
              <div class="fb-small">${esc(b.details || "")}</div>
            </div>
            <span class="fb-pill ${b.is_available ? "approved" : "pending"}">${b.is_available ? "Available" : "Not now"}</span>
          </div>
        `).join("")}
      </div>
    `;
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
        <label class="fb-label">Choose faction banker group</label>
        <select id="fb-target-faction" class="fb-input">
          ${factionOptions()}
        </select>

        <label class="fb-label" style="margin-top:10px;">Choose banker now</label>
        <select id="fb-target-banker" class="fb-input fb-banker-select">
          ${bankerOptions()}
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
          Pick the Deadly Sins faction group first. Only bankers assigned to that faction will get the red coin notification.
        </div>
      </div>
    `);

    $("#fb-target-faction")?.addEventListener("change", () => handleFactionChangeAndReload("#fb-target-faction"));
    $("#fb-submit-request")?.addEventListener("click", submitRequest);
    $("#fb-full-request")?.addEventListener("click", submitFullBalanceRequest);
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

  function openBankingPageForRequest(r) {
    if (!r) return;
    savePayPrefill(r);
    showPayNotice("Opening Torn faction bank. Player and amount will auto-fill when the bank form loads. You still manually press Give Money.");
    window.location.href = "https://www.torn.com/factions.php?step=your#/tab=controls";
  }

  function setNativeValue(input, value) {
    if (!input) return false;
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
    return true;
  }

  function visibleInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
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

  function bestInput(kind) {
    const inputs = Array.from(document.querySelectorAll("input, textarea"))
      .filter(visibleInput)
      .filter((el) => !String(el.type || "").match(/hidden|submit|button|checkbox|radio/i));

    const scored = inputs.map((el) => ({ el, score: scoreInputFor(el, kind) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.el || null;
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
    const amountInput = bestInput("amount");
    let filled = false;

    if (playerInput) {
      filled = setNativeValue(playerInput, `${data.playerName} [${data.playerId}]`) || filled;
    }

    if (amountInput && data.amount) {
      filled = setNativeValue(amountInput, String(data.amount)) || filled;
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
      setBody(`
        <div class="fb-box">
          <div class="fb-error">${esc(err.message || err)}</div>
        </div>
      `);
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

  function renderSettings(msg = "") {
    const key = GM_getValue(K_API_KEY, "");

    setBody(`
      ${msg ? `<div class="fb-box"><div class="fb-error">${esc(msg)}</div></div>` : ""}

      <div class="fb-box">
        <div class="fb-request-title">Settings</div>
        <div class="fb-small" style="margin-top:4px;">
          Save your Torn API key so the banker app can verify your faction/account. After saving, tap Test Login.
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
        <div class="fb-request-title">Phone Pushover Ping</div>
        <div class="fb-small" style="margin-top:6px;">
          Your phone ping is sent by Render when a request is created. Add these Render env vars: PUSHOVER_USER_KEY and PUSHOVER_API_TOKEN. Test with /api/test-pushover.
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

    APP.busy = true;
    if (status) status.textContent = "Sending full balance request...";

    try {
      await gmRequest("POST", "/api/banker/requests", {
        amount: 1,
        note: FULL_BALANCE_NOTE,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });

      GM_setValue(K_TARGET_FACTION, targetFactionId);
      if (status) status.textContent = `Full balance request sent to ${factionLabelById(targetFactionId)} bankers`;
      await refreshAll(true);

      if (APP.open) {
        renderRequestTab(`<div class="fb-success">Full balance request sent to ${esc(factionLabelById(targetFactionId))} bankers.</div>`);
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
      await gmRequest("POST", "/api/banker/requests", {
        amount,
        note,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });
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
      await gmRequest("POST", "/api/banker/requests", {
        amount,
        note,
        target_faction_id: targetFactionId,
        target_banker_id: targetBankerId,
      });
      GM_setValue(K_TARGET_FACTION, targetFactionId);
      await refreshAll(true);
      renderRequestTab(`<div class="fb-success">Amount request sent to ${esc(factionLabelById(targetFactionId))} bankers.</div>`);
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



  function upsertRequestItem(item) {
    if (!item || !item.id) return;

    const id = String(item.id);
    const list = Array.isArray(APP.requests) ? APP.requests.slice() : [];
    const idx = list.findIndex((r) => String(r.id) === id);

    if (idx >= 0) list[idx] = item;
    else list.unshift(item);

    APP.requests = list;
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

      const list = await gmRequest("GET", "/api/banker/requests");
      APP.requests = Array.isArray(list.items) ? list.items : [];

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

    if (!isProfilePage()) {
      const profileCoin = document.querySelector("#fb-profile-bank-coin");
      if (profileCoin) profileCoin.remove();
    }

    // Never allow the old floating coin to remain on normal pages.
    document.querySelectorAll("#fb-bank-coin, #fb-bank-coin-clean").forEach((el) => el.remove());
  }

  let mountTimer = null;
  let mountTries = 0;

  function pageMount(reason = "manual") {
    if (!isTornPage()) return;

    ensureStyles();
    clearBankerUiOnWrongPage();

    // Only create the overlay when the user taps Board/profile coin. Never auto-open it on normal pages.
    if (APP.open) ensureOverlay();

    if (isOwnFactionPage()) {
      mountBuiltInBankerBox();

      // PDA-safe: only load factions/me/banker status for the quick box.
      // Do not call /api/banker/requests here because that uses the database and caused 500s.
      if (GM_getValue(K_API_KEY, "") && (Date.now() - (APP.lastQuickLoad || 0) > 45000 || reason === "url")) {
        refreshFactionBoxData(false);
      }
    }

    if (isProfilePage()) {
      mountProfileBankCoin();
    }
  }

  function scheduleMount(reason = "scheduled") {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(() => pageMount(reason), 450);
  }

  function boot() {
    if (!isTornPage() || APP.booted) return;

    ensureStyles();
    clearBankerUiOnWrongPage();

    APP.booted = true;

    // Do not restore an old open board on app start. This stops the board from appearing on Gym/Home/etc.
    GM_setValue(K_OPEN, false);
    APP.open = false;

    pageMount("boot");

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

      const usefulPage = APP.open || isOwnFactionPage() || isProfilePage();
      if (!usefulPage) return;

      pageMount("slow");

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
    setTimeout(tryPrefillFactionBankForm, 1000);
    setTimeout(tryPrefillFactionBankForm, 2600);
  }
})();
