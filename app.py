import os
import time
import threading
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests

app = Flask(__name__, static_folder="static")
CORS(app)

TORN_API_BASE = os.getenv("TORN_API_BASE", "https://api.torn.com").rstrip("/")
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "20"))

ADMIN_PLAYER_ID = str(os.getenv("ADMIN_PLAYER_ID", "3679030")).strip()
BANKER_IDS = {
    x.strip()
    for x in os.getenv("BANKER_IDS", "3679030").split(",")
    if x.strip()
}

REQUESTS = []
NEXT_ID = 1
LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_key():
    key = request.headers.get("X-Torn-Key", "").strip()
    if not key:
        key = request.args.get("key", "").strip()
    return key


def torn_get_user(key):
    if not key:
        return None, "Missing Torn API key"

    url = f"{TORN_API_BASE}/user/?selections=profile&key={key}"

    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        data = r.json()
    except Exception as e:
        return None, f"Torn API request failed: {e}"

    if not isinstance(data, dict):
        return None, "Bad Torn API response"

    if data.get("error"):
        err = data.get("error") or {}
        return None, err.get("error", "Torn API error")

    player_id = str(data.get("player_id") or data.get("id") or "").strip()
    name = str(data.get("name") or "Unknown").strip()

    faction = data.get("faction") or {}
    faction_id = ""
    faction_name = ""

    if isinstance(faction, dict):
        faction_id = str(faction.get("faction_id") or faction.get("id") or "").strip()
        faction_name = str(faction.get("faction_name") or faction.get("name") or "").strip()

    user = {
        "player_id": player_id,
        "name": name,
        "faction_id": faction_id,
        "faction_name": faction_name,
        "is_admin": player_id == ADMIN_PLAYER_ID,
        "is_banker": player_id in BANKER_IDS or player_id == ADMIN_PLAYER_ID,
    }

    if not player_id:
        return None, "Could not read player ID from Torn"

    if not faction_id:
        return None, "You must be in a faction to use Faction Bankers"

    return user, None


def require_user():
    key = get_key()
    user, err = torn_get_user(key)
    if err:
        return None, jsonify({"ok": False, "error": err}), 401
    return user, None, None


def clean_request_for_user(item):
    return dict(item)


@app.get("/")
def home():
    return jsonify({
        "ok": True,
        "app": "Faction Bankers",
        "mode": "in-memory",
        "note": "Requests reset when Render restarts.",
        "endpoints": [
            "/api/health",
            "/api/banker/me",
            "/api/banker/requests",
        ],
    })


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "app": "Faction Bankers",
        "mode": "in-memory",
        "requests": len(REQUESTS),
        "banker_ids": sorted(BANKER_IDS),
        "admin_player_id": ADMIN_PLAYER_ID,
        "time": now_iso(),
    })


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


@app.get("/api/banker/me")
def banker_me():
    user, resp, code = require_user()
    if resp:
        return resp, code

    return jsonify({
        "ok": True,
        "player_id": user["player_id"],
        "name": user["name"],
        "faction_id": user["faction_id"],
        "faction_name": user["faction_name"],
        "is_admin": user["is_admin"],
        "is_banker": user["is_banker"],
    })


@app.get("/api/banker/requests")
def list_requests():
    user, resp, code = require_user()
    if resp:
        return resp, code

    with LOCK:
        items = [
            clean_request_for_user(x)
            for x in REQUESTS
            if str(x.get("faction_id")) == str(user["faction_id"])
        ]

    items.sort(key=lambda x: x.get("created_ts", 0), reverse=True)

    return jsonify({
        "ok": True,
        "items": items,
        "count": len(items),
    })


@app.post("/api/banker/requests")
def create_request():
    global NEXT_ID

    user, resp, code = require_user()
    if resp:
        return resp, code

    data = request.get_json(silent=True) or {}

    amount = data.get("amount", 0)
    note = str(data.get("note") or "").strip()

    try:
        amount = int(str(amount).replace(",", "").replace("$", "").strip())
    except Exception:
        amount = 0

    if amount <= 0:
        return jsonify({"ok": False, "error": "Enter a valid amount"}), 400

    if len(note) > 500:
        note = note[:500]

    with LOCK:
        req_id = NEXT_ID
        NEXT_ID += 1

        item = {
            "id": req_id,
            "status": "pending",
            "amount": amount,
            "note": note,
            "requester_id": user["player_id"],
            "requester_name": user["name"],
            "faction_id": user["faction_id"],
            "faction_name": user["faction_name"],
            "created_at": now_iso(),
            "created_ts": time.time(),
            "handled_by_id": "",
            "handled_by_name": "",
            "handled_at": "",
            "bank_note": "",
        }

        REQUESTS.append(item)

    return jsonify({
        "ok": True,
        "item": item,
    })


@app.post("/api/banker/requests/<int:req_id>/<action>")
def banker_action(req_id, action):
    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    action = str(action or "").lower().strip()

    status_map = {
        "approve": "approved",
        "approved": "approved",
        "paid": "paid",
        "mark_paid": "paid",
        "deny": "denied",
        "denied": "denied",
    }

    if action not in status_map:
        return jsonify({"ok": False, "error": "Invalid action"}), 400

    data = request.get_json(silent=True) or {}
    bank_note = str(data.get("note") or "").strip()

    if len(bank_note) > 500:
        bank_note = bank_note[:500]

    with LOCK:
        item = None

        for x in REQUESTS:
            if int(x.get("id")) == int(req_id):
                item = x
                break

        if not item:
            return jsonify({"ok": False, "error": "Request not found"}), 404

        if str(item.get("faction_id")) != str(user["faction_id"]):
            return jsonify({"ok": False, "error": "Wrong faction"}), 403

        item["status"] = status_map[action]
        item["handled_by_id"] = user["player_id"]
        item["handled_by_name"] = user["name"]
        item["handled_at"] = now_iso()

        if bank_note:
            item["bank_note"] = bank_note

    return jsonify({
        "ok": True,
        "item": item,
    })


@app.post("/api/banker/clear-paid")
def clear_paid():
    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    with LOCK:
        before = len(REQUESTS)
        REQUESTS[:] = [
            x for x in REQUESTS
            if not (
                str(x.get("faction_id")) == str(user["faction_id"])
                and str(x.get("status")) in {"paid", "denied", "cancelled"}
            )
        ]
        removed = before - len(REQUESTS)

    return jsonify({
        "ok": True,
        "removed": removed,
    })


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
