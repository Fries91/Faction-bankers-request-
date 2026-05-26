import json
import os
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException


app = Flask(__name__, static_folder="static")
CORS(app)


@app.errorhandler(Exception)
def json_error_handler(e):
    # Make PDA/userscript errors readable instead of returning a raw HTML 500 page.
    if isinstance(e, HTTPException):
        return jsonify({"ok": False, "error": e.description or e.name}), e.code or 500
    print("Unhandled server error:", repr(e))
    return jsonify({"ok": False, "error": str(e) or e.__class__.__name__}), 500


DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
TORN_API_BASE = os.getenv("TORN_API_BASE", "https://api.torn.com").rstrip("/")
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "20"))

ADMIN_PLAYER_ID = str(os.getenv("ADMIN_PLAYER_ID", "3679030")).strip()
BANKER_IDS = {
    x.strip()
    for x in os.getenv("BANKER_IDS", "3679030").split(",")
    if x.strip()
}


def load_faction_bankers():
    """
    Reads FACTION_BANKERS from Render.

    Format:
    {"52040":{"name":"Sloth","bankers":["3679030"]},"49384":{"name":"Wrath","bankers":["3509957"]}}
    """
    raw = os.getenv("FACTION_BANKERS", "").strip()

    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                cleaned = {}
                for faction_id, info in data.items():
                    fid = str(faction_id).strip()
                    if not fid:
                        continue

                    if not isinstance(info, dict):
                        info = {"name": str(info), "bankers": []}

                    name = str(info.get("name") or fid).strip()
                    bankers = [
                        str(x).strip()
                        for x in (info.get("bankers") or [])
                        if str(x).strip()
                    ]

                    cleaned[fid] = {
                        "name": name,
                        "bankers": bankers,
                    }

                if cleaned:
                    return cleaned
        except Exception:
            # Keep the app alive even if the env var is temporarily malformed.
            pass

    # PDA-safe fallback if FACTION_BANKERS is missing or malformed.
    # This keeps the status list working instead of returning "Selected faction is not configured"
    # while Render env vars are being adjusted. Fries91/Admin is included by default.
    fallback_bankers = sorted(BANKER_IDS or {ADMIN_PLAYER_ID})
    return {
        "49384": {"name": "Wrath", "bankers": fallback_bankers},
        "52040": {"name": "Sloth", "bankers": fallback_bankers},
        "8315": {"name": "Greed", "bankers": fallback_bankers},
        "20554": {"name": "Pride", "bankers": fallback_bankers},
    }


FACTION_BANKERS = load_faction_bankers()
BANKER_STATUS_CACHE = {}
BANKER_STATUS_TTL = int(os.getenv("BANKER_STATUS_TTL", "45"))

# Safety fallback: if Render Postgres/DATABASE_URL is missing or broken,
# requests still work in memory instead of crashing with HTML 500.
# Memory requests reset when Render restarts, so Postgres is still recommended.
MEMORY_REQUESTS = []
MEMORY_NEXT_ID = 1

def is_hidden_banker_name_or_id(name_or_id):
    """Hide bankers the owner removed from the user-facing app.
    Default hides PulseArts/Pulse unless OVERRIDE env is provided.
    Add more via HIDDEN_BANKER_IDS=123,456 or HIDDEN_BANKER_NAMES=Name1,Name2.
    """
    value = str(name_or_id or "").strip().lower()
    if not value:
        return False
    hidden_ids = {x.strip().lower() for x in os.getenv("HIDDEN_BANKER_IDS", "").split(",") if x.strip()}
    hidden_names = {x.strip().lower() for x in os.getenv("HIDDEN_BANKER_NAMES", "pulsearts,pulse").split(",") if x.strip()}
    return value in hidden_ids or value in hidden_names or value.startswith("pulsearts")


def all_configured_faction_ids():
    return [fid for fid in FACTION_BANKERS.keys() if fid != "default"]


def banker_factions_for_player(player_id):
    pid = str(player_id).strip()

    if pid == ADMIN_PLAYER_ID:
        return all_configured_faction_ids()

    allowed = []
    for faction_id, info in FACTION_BANKERS.items():
        if faction_id == "default":
            continue

        bankers = {str(x).strip() for x in info.get("bankers", []) if str(x).strip()}
        if pid in bankers:
            allowed.append(str(faction_id))

    return allowed


def faction_name_for_id(faction_id):
    fid = str(faction_id).strip()
    info = FACTION_BANKERS.get(fid) or {}
    return str(info.get("name") or fid).strip()


def public_factions():
    return [
        {
            "faction_id": str(fid),
            "faction_name": faction_name_for_id(fid),
        }
        for fid in all_configured_faction_ids()
    ]


def bankers_for_faction(faction_id):
    fid = str(faction_id or "").strip()
    info = FACTION_BANKERS.get(fid) or {}
    bankers = []

    for raw in info.get("bankers", []) or []:
        if isinstance(raw, dict):
            bid = str(raw.get("id") or raw.get("player_id") or raw.get("xid") or "").strip()
            bname = str(raw.get("name") or raw.get("player_name") or "").strip()
        else:
            bid = str(raw).strip()
            bname = ""
        if bid and not is_hidden_banker_name_or_id(bid) and not is_hidden_banker_name_or_id(bname) and bid not in bankers:
            bankers.append(bid)

    # If a faction exists but has no banker list, still show the legacy/admin bankers.
    if not bankers:
        bankers = sorted(BANKER_IDS or {ADMIN_PLAYER_ID})

    # Always include Fries91/admin as a banker safety fallback.
    if ADMIN_PLAYER_ID and ADMIN_PLAYER_ID not in bankers:
        bankers.insert(0, ADMIN_PLAYER_ID)

    return bankers


def banker_name_from_config(faction_id, banker_id):
    fid = str(faction_id or "").strip()
    bid = str(banker_id or "").strip()
    info = FACTION_BANKERS.get(fid) or {}
    for raw in info.get("bankers", []) or []:
        if isinstance(raw, dict):
            rid = str(raw.get("id") or raw.get("player_id") or raw.get("xid") or "").strip()
            if rid == bid:
                return str(raw.get("name") or raw.get("player_name") or bid).strip()
    if bid == ADMIN_PLAYER_ID:
        return "Fries91"
    return bid


def classify_banker_status(data):
    status_obj = data.get("status") if isinstance(data, dict) else {}
    last_action = data.get("last_action") if isinstance(data, dict) else {}
    travel = data.get("travel") if isinstance(data, dict) else {}

    details = ""
    state = "Unknown"
    torn_color = ""

    if isinstance(status_obj, dict):
        state = str(status_obj.get("state") or "Unknown")
        details = str(status_obj.get("details") or state)
        torn_color = str(status_obj.get("color") or "")
    elif status_obj:
        details = str(status_obj)
        state = details

    last_status = ""
    last_relative = ""
    if isinstance(last_action, dict):
        last_status = str(last_action.get("status") or "")
        last_relative = str(last_action.get("relative") or "")

    travel_text = ""
    if isinstance(travel, dict) and travel:
        dest = travel.get("destination") or travel.get("dest") or ""
        timestamp = travel.get("timestamp") or travel.get("time_left") or ""
        if dest:
            travel_text = f"Traveling: {dest}"
        if timestamp:
            travel_text = (travel_text + f" • {timestamp}").strip(" •")

    combined = " ".join([state, details, last_status, travel_text]).lower()

    if any(x in combined for x in ["travel", "flying", "returning", "abroad"]):
        app_status = "traveling"
        app_color = "yellow" if "return" in combined or "travel" in combined or "flying" in combined else "blue"
        app_label = "Traveling / Abroad"
    elif "online" in combined or torn_color == "green":
        app_status = "online"
        app_color = "green"
        app_label = "Online"
    elif "idle" in combined or torn_color == "orange":
        app_status = "idle"
        app_color = "orange"
        app_label = "Idle"
    elif "hospital" in combined:
        app_status = "hospital"
        app_color = "red"
        app_label = "Hospital"
    elif "jail" in combined:
        app_status = "jail"
        app_color = "red"
        app_label = "Jail"
    elif "offline" in combined or torn_color == "red":
        app_status = "offline"
        app_color = "red"
        app_label = "Offline"
    else:
        app_status = "unknown"
        app_color = "gray"
        app_label = "Unknown"

    subtitle = travel_text or details or last_relative or state
    return app_status, app_color, app_label, subtitle


def torn_get_banker_status(key, banker_id, faction_id=""):
    bid = str(banker_id or "").strip()
    cache_key = f"{bid}:{key[-6:] if key else ''}"
    cached = BANKER_STATUS_CACHE.get(cache_key)
    if cached and time.time() - cached.get("ts", 0) < BANKER_STATUS_TTL:
        return cached.get("item")

    item = {
        "player_id": bid,
        "name": banker_name_from_config(faction_id, bid),
        "status": "unknown",
        "color": "gray",
        "label": "Unknown",
        "details": "Status unavailable",
        "is_available": False,
    }

    if not bid:
        return item

    if not key:
        BANKER_STATUS_CACHE[cache_key] = {"ts": time.time(), "item": item}
        return item

    url = f"{TORN_API_BASE}/user/{bid}?selections=profile&key={key}"
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        data = r.json()
        if isinstance(data, dict) and not data.get("error"):
            name = str(data.get("name") or banker_name_from_config(faction_id, bid) or bid).strip()
            status, color, label, details = classify_banker_status(data)
            item = {
                "player_id": bid,
                "name": name,
                "status": status,
                "color": color,
                "label": label,
                "details": details or label,
                "is_available": status in {"online", "idle"},
            }
        elif isinstance(data, dict) and data.get("error"):
            err = data.get("error") or {}
            item["details"] = str(err.get("error") or "Torn API denied status check")[:160]
    except Exception as e:
        item["details"] = f"Status check failed: {e}"[:160]

    BANKER_STATUS_CACHE[cache_key] = {"ts": time.time(), "item": item}
    return item


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing")

    return psycopg2.connect(
        DATABASE_URL,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def db_error_response(prefix="Database is not ready"):
    if not DATABASE_URL:
        return jsonify({
            "ok": False,
            "error": "DATABASE_URL is missing in Render. Attach a Postgres database or add DATABASE_URL in Environment."
        }), 503
    return jsonify({"ok": False, "error": prefix}), 500


def init_db():
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS banker_requests (
                    id SERIAL PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'pending',
                    amount BIGINT NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '',
                    requester_id TEXT NOT NULL,
                    requester_name TEXT NOT NULL,
                    faction_id TEXT NOT NULL,
                    faction_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    created_ts DOUBLE PRECISION NOT NULL,
                    handled_by_id TEXT NOT NULL DEFAULT '',
                    handled_by_name TEXT NOT NULL DEFAULT '',
                    handled_at TEXT NOT NULL DEFAULT '',
                    bank_note TEXT NOT NULL DEFAULT '',
                    is_active BOOLEAN NOT NULL DEFAULT TRUE
                )
                """
            )

            cur.execute("ALTER TABLE banker_requests ADD COLUMN IF NOT EXISTS selected_banker_id TEXT NOT NULL DEFAULT ''")
            cur.execute("ALTER TABLE banker_requests ADD COLUMN IF NOT EXISTS selected_banker_name TEXT NOT NULL DEFAULT ''")

            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_banker_requests_faction_active
                ON banker_requests (faction_id, is_active, created_ts DESC)
                """
            )

        conn.commit()


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

    if not player_id:
        return None, "Could not read player ID from Torn"

    if not faction_id:
        return None, "You must be in a faction to use Faction Bankers"

    banker_factions = banker_factions_for_player(player_id)

    # Keep BANKER_IDS working as a legacy fallback if FACTION_BANKERS is not configured yet.
    legacy_banker = player_id in BANKER_IDS or player_id == ADMIN_PLAYER_ID
    if legacy_banker and not banker_factions and "default" in FACTION_BANKERS:
        banker_factions = [faction_id]

    user = {
        "player_id": player_id,
        "name": name,
        "faction_id": faction_id,
        "faction_name": faction_name,
        "is_admin": player_id == ADMIN_PLAYER_ID,
        "is_banker": bool(banker_factions) or legacy_banker,
        "banker_factions": banker_factions,
    }

    return user, None


def require_user():
    key = get_key()
    user, err = torn_get_user(key)

    if err:
        return None, jsonify({"ok": False, "error": err}), 401

    return user, None, None


def public_base_url():
    return os.getenv("PUBLIC_BASE_URL", "https://faction-bankers-request.onrender.com").rstrip("/")


def pushover_configured():
    return bool(os.getenv("PUSHOVER_USER_KEY", "").strip() and os.getenv("PUSHOVER_API_TOKEN", "").strip())


def send_pushover_alert(title, message, url=None):
    """Send direct phone ping through Pushover.

    Render env vars needed:
    PUSHOVER_USER_KEY=your personal Pushover user key
    PUSHOVER_API_TOKEN=your Pushover application token
    """
    user_key = os.getenv("PUSHOVER_USER_KEY", "").strip()
    api_token = os.getenv("PUSHOVER_API_TOKEN", "").strip()

    if not user_key or not api_token:
        print("Pushover not configured")
        return False

    payload = {
        "token": api_token,
        "user": user_key,
        "title": str(title)[:250],
        "message": str(message)[:1024],
        "priority": 1,
    }

    if url:
        payload["url"] = str(url)[:512]
        payload["url_title"] = "Open Bank Request"

    try:
        response = requests.post(
            "https://api.pushover.net/1/messages.json",
            data=payload,
            timeout=10,
        )
        print("Pushover:", response.status_code, response.text[:300])
        return response.ok
    except Exception as e:
        print("Pushover error:", e)
        return False


def send_bank_request_ping(item):
    if not item:
        return False

    is_full_balance = str(item.get("note") or "") == "__FULL_BALANCE_REQUEST__"
    amount_text = "Full Balance" if is_full_balance else f"${int(item.get('amount') or 0):,}"
    request_url = f"https://www.torn.com/factions.php?step=your&fb_bank_req={item.get('id')}#/tab=controls"

    message = (
        f"Player: {item.get('requester_name')} [{item.get('requester_id')}]\n"
        f"Amount: {amount_text}\n"
        f"Faction: {item.get('faction_name')}\n"
        f"Preferred Banker: {item.get('selected_banker_name') or 'Any available banker'}\n"
        f"Request ID: #{item.get('id')}"
    )

    return send_pushover_alert(
        "🪙 New Torn Bank Request",
        message,
        request_url,
    )


def row_to_item(row):
    return {
        "id": row["id"],
        "status": row["status"],
        "amount": row["amount"],
        "note": row["note"] or "",
        "requester_id": row["requester_id"],
        "requester_name": row["requester_name"],
        "faction_id": row["faction_id"],
        "faction_name": row["faction_name"],
        "created_at": row["created_at"],
        "created_ts": row["created_ts"],
        "handled_by_id": row["handled_by_id"] or "",
        "handled_by_name": row["handled_by_name"] or "",
        "handled_at": row["handled_at"] or "",
        "bank_note": row["bank_note"] or "",
        "selected_banker_id": row.get("selected_banker_id", "") or "",
        "selected_banker_name": row.get("selected_banker_name", "") or "",
    }



def db_ready():
    if not DATABASE_URL:
        return False, "DATABASE_URL missing; using memory fallback"
    try:
        init_db()
        return True, "postgres"
    except Exception as e:
        print("DB unavailable; using memory fallback:", e)
        return False, str(e)


def memory_visible_items(user):
    if user.get("is_admin"):
        faction_ids = set(all_configured_faction_ids() or [user.get("faction_id")])
        return [r for r in MEMORY_REQUESTS if r.get("is_active", True) and (r.get("faction_id") in faction_ids or r.get("requester_id") == user.get("player_id"))]
    if user.get("is_banker"):
        faction_ids = set(user.get("banker_factions") or [user.get("faction_id")])
        return [r for r in MEMORY_REQUESTS if r.get("is_active", True) and (r.get("faction_id") in faction_ids or r.get("requester_id") == user.get("player_id"))]
    return [r for r in MEMORY_REQUESTS if r.get("is_active", True) and r.get("requester_id") == user.get("player_id")]


def memory_get_visible_request(req_id, user):
    for item in memory_visible_items(user):
        if int(item.get("id", 0)) == int(req_id):
            return item
    return None


def memory_insert_request(user, amount, note, target_faction_id, target_faction_name, selected_banker_id="", selected_banker_name=""):
    global MEMORY_NEXT_ID
    item = {
        "id": MEMORY_NEXT_ID,
        "status": "pending",
        "amount": int(amount or 0),
        "note": note or "",
        "requester_id": user["player_id"],
        "requester_name": user["name"],
        "faction_id": target_faction_id,
        "faction_name": target_faction_name,
        "selected_banker_id": selected_banker_id or "",
        "selected_banker_name": selected_banker_name or "",
        "created_at": now_iso(),
        "created_ts": time.time(),
        "handled_by_id": "",
        "handled_by_name": "",
        "handled_at": "",
        "bank_note": "",
        "is_active": True,
    }
    MEMORY_NEXT_ID += 1
    MEMORY_REQUESTS.insert(0, item)
    return item


def memory_update_request(req_id, user, new_status, bank_note=""):
    allowed_factions = set(all_configured_faction_ids() if user.get("is_admin") else user.get("banker_factions", []))
    for item in MEMORY_REQUESTS:
        if int(item.get("id", 0)) == int(req_id) and item.get("is_active", True) and item.get("faction_id") in allowed_factions:
            item["status"] = new_status
            item["handled_by_id"] = user["player_id"]
            item["handled_by_name"] = user["name"]
            item["handled_at"] = now_iso()
            if bank_note:
                item["bank_note"] = bank_note
            item["is_active"] = new_status not in {"complete", "denied"}
            return item
    return None


@app.get("/")
def home():
    return jsonify(
        {
            "ok": True,
            "app": "Faction Bankers",
            "mode": "postgres",
            "note": "Active requests are stored until banker completes or denies them.",
            "endpoints": [
                "/api/health",
                "/api/banker/me",
                "/api/banker/requests",
            ],
        }
    )


@app.get("/api/health")
def health():
    ready, db_msg = db_ready()
    active_count = 0
    mode = "memory"
    if ready:
        mode = "postgres"
        try:
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) AS count FROM banker_requests WHERE is_active = TRUE")
                    row = cur.fetchone()
                    active_count = int(row["count"] or 0)
        except Exception as e:
            ready = False
            db_msg = str(e)
            active_count = len([r for r in MEMORY_REQUESTS if r.get("is_active", True)])
            mode = "memory"
    else:
        active_count = len([r for r in MEMORY_REQUESTS if r.get("is_active", True)])

    return jsonify({
        "ok": True,
        "app": "Faction Bankers",
        "mode": mode,
        "db_ready": ready,
        "db_message": db_msg,
        "active_requests": active_count,
        "banker_ids": sorted(BANKER_IDS),
        "faction_bankers": public_factions(),
        "admin_player_id": ADMIN_PLAYER_ID,
        "pushover_configured": pushover_configured(),
        "public_base_url": public_base_url(),
        "time": now_iso(),
    })


@app.get("/api/test-pushover")
def test_pushover():
    ok = send_pushover_alert(
        "🪙 Test Bank Ping",
        "Your Faction Bankers Pushover phone alert is working.",
        "https://www.torn.com/factions.php?step=your#/tab=controls",
    )
    return jsonify({"ok": ok, "pushover_configured": pushover_configured()})


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)



@app.get("/api/banker/factions")
def banker_factions():
    return jsonify(
        {
            "ok": True,
            "items": public_factions(),
            "count": len(public_factions()),
        }
    )

@app.get("/api/banker/status")
def banker_status():
    user, resp, code = require_user()
    if resp:
        return resp, code

    key = get_key()
    requested_faction_id = str(request.args.get("faction_id") or "").strip()

    if not requested_faction_id:
        requested_faction_id = user.get("faction_id") or ""

    if requested_faction_id not in FACTION_BANKERS:
        # Do not break the PDA userscript if the dropdown has a faction that Render env does not yet know.
        # Use legacy/admin bankers so members still see Fries91 and can send a request.
        banker_ids = sorted(BANKER_IDS or {ADMIN_PLAYER_ID})
        faction_name = requested_faction_id or "Faction"
    else:
        banker_ids = bankers_for_faction(requested_faction_id)
        faction_name = faction_name_for_id(requested_faction_id)

    items = [torn_get_banker_status(key, bid, requested_faction_id) for bid in banker_ids]
    items = [x for x in items if not is_hidden_banker_name_or_id(x.get("player_id")) and not is_hidden_banker_name_or_id(x.get("name"))]

    # Available bankers first, then traveling/idle/offline.
    rank = {"online": 0, "idle": 1, "traveling": 2, "hospital": 3, "jail": 4, "offline": 5, "unknown": 6}
    items.sort(key=lambda x: (rank.get(str(x.get("status")), 9), str(x.get("name") or "").lower()))

    return jsonify({
        "ok": True,
        "faction_id": requested_faction_id,
        "faction_name": faction_name,
        "items": items,
        "count": len(items),
        "time": now_iso(),
    })


@app.get("/api/banker/me")
def banker_me():
    user, resp, code = require_user()
    if resp:
        return resp, code

    return jsonify(
        {
            "ok": True,
            "player_id": user["player_id"],
            "name": user["name"],
            "faction_id": user["faction_id"],
            "faction_name": user["faction_name"],
            "is_admin": user["is_admin"],
            "is_banker": user["is_banker"],
            "banker_factions": user.get("banker_factions", []),
            "available_factions": public_factions(),
        }
    )


@app.get("/api/banker/requests")
def list_requests():
    user, resp, code = require_user()
    if resp:
        return resp, code

    db_ok, db_msg = db_ready()
    if not db_ok:
        items = [dict(x) for x in memory_visible_items(user)]
        return jsonify({"ok": True, "items": items, "count": len(items), "mode": "memory", "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            if user["is_admin"]:
                faction_ids = all_configured_faction_ids()
                if not faction_ids:
                    faction_ids = [user["faction_id"]]
            elif user["is_banker"]:
                faction_ids = user.get("banker_factions", []) or [user["faction_id"]]
            else:
                faction_ids = []

            if faction_ids:
                cur.execute(
                    """
                    SELECT *
                    FROM banker_requests
                    WHERE is_active = TRUE
                      AND (
                        faction_id = ANY(%s)
                        OR requester_id = %s
                      )
                    ORDER BY created_ts DESC
                    """,
                    (faction_ids, user["player_id"]),
                )
            else:
                cur.execute(
                    """
                    SELECT *
                    FROM banker_requests
                    WHERE requester_id = %s
                      AND is_active = TRUE
                    ORDER BY created_ts DESC
                    """,
                    (user["player_id"],),
                )

            rows = cur.fetchall()

    items = [row_to_item(row) for row in rows]

    return jsonify(
        {
            "ok": True,
            "items": items,
            "count": len(items),
        }
    )



@app.get("/api/banker/requests/<int:req_id>")
def get_request(req_id):
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user.get("is_banker"):
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    allowed_factions = all_configured_faction_ids() if user.get("is_admin") else user.get("banker_factions", [])
    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker factions configured for your account"}), 403

    if not db_ok:
        item = memory_get_visible_request(req_id, user)
        if not item:
            return jsonify({"ok": False, "error": "Request not found"}), 404
        return jsonify({"ok": True, "item": item, "mode": "memory", "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM banker_requests
                WHERE id = %s
                  AND faction_id = ANY(%s)
                  AND is_active = TRUE
                """,
                (req_id, allowed_factions),
            )
            row = cur.fetchone()

    if not row:
        return jsonify({"ok": False, "error": "Request not found"}), 404

    return jsonify({"ok": True, "item": row_to_item(row)})

@app.post("/api/banker/requests")
def create_request():
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    data = request.get_json(silent=True) or {}

    amount = data.get("amount", 0)
    note = str(data.get("note") or "").strip()
    selected_faction_id = str(data.get("target_faction_id") or "").strip()
    selected_banker_id = str(data.get("target_banker_id") or "").strip()

    try:
        amount = int(str(amount).replace(",", "").replace("$", "").strip())
    except Exception:
        amount = 0

    if amount <= 0:
        return jsonify({"ok": False, "error": "Enter a valid amount"}), 400

    if len(note) > 500:
        note = note[:500]

    configured = all_configured_faction_ids()

    if configured:
        if not selected_faction_id:
            # If their own faction is configured, default to it. Otherwise force dropdown choice.
            if user["faction_id"] in FACTION_BANKERS:
                selected_faction_id = user["faction_id"]
            else:
                return jsonify({"ok": False, "error": "Choose a faction banker group"}), 400

        if selected_faction_id not in FACTION_BANKERS:
            return jsonify({"ok": False, "error": "Selected faction is not configured"}), 400

        target_faction_id = selected_faction_id
        target_faction_name = faction_name_for_id(selected_faction_id)
    else:
        target_faction_id = user["faction_id"]
        target_faction_name = user["faction_name"]

    selected_banker_name = ""
    if selected_banker_id:
        allowed_bankers = set(bankers_for_faction(target_faction_id))
        if selected_banker_id not in allowed_bankers:
            return jsonify({"ok": False, "error": "Selected banker is not assigned to that faction group"}), 400
        try:
            selected_banker_status = torn_get_banker_status(get_key(), selected_banker_id, target_faction_id)
            selected_banker_name = str(selected_banker_status.get("name") or selected_banker_id).strip()
        except Exception:
            selected_banker_name = selected_banker_id

    created_at = now_iso()
    created_ts = time.time()

    if not db_ok:
        item = memory_insert_request(user, amount, note, target_faction_id, target_faction_name, selected_banker_id, selected_banker_name)
        ping_sent = send_bank_request_ping(item)
        return jsonify({"ok": True, "item": item, "pushover_sent": ping_sent, "mode": "memory", "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO banker_requests (
                    status,
                    amount,
                    note,
                    requester_id,
                    requester_name,
                    faction_id,
                    faction_name,
                    selected_banker_id,
                    selected_banker_name,
                    created_at,
                    created_ts,
                    is_active
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE)
                RETURNING *
                """,
                (
                    "pending",
                    amount,
                    note,
                    user["player_id"],
                    user["name"],
                    target_faction_id,
                    target_faction_name,
                    selected_banker_id,
                    selected_banker_name,
                    created_at,
                    created_ts,
                ),
            )

            row = cur.fetchone()

        conn.commit()

    item = row_to_item(row)
    ping_sent = send_bank_request_ping(item)

    return jsonify(
        {
            "ok": True,
            "item": item,
            "pushover_sent": ping_sent,
        }
    )


@app.post("/api/banker/requests/<int:req_id>/<action>")
def banker_action(req_id, action):
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    action = str(action or "").lower().strip()

    status_map = {
        "approve": "approved",
        "approved": "approved",
        "paid": "complete",
        "complete": "complete",
        "mark_paid": "complete",
        "mark_complete": "complete",
        "deny": "denied",
        "denied": "denied",
    }

    if action not in status_map:
        return jsonify({"ok": False, "error": "Invalid action"}), 400

    new_status = status_map[action]

    data = request.get_json(silent=True) or {}
    bank_note = str(data.get("note") or "").strip()

    if len(bank_note) > 500:
        bank_note = bank_note[:500]

    # Complete/denied requests are removed from active list.
    is_active = new_status not in {"complete", "denied"}

    allowed_factions = all_configured_faction_ids() if user["is_admin"] else user.get("banker_factions", [])

    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker factions configured for your account"}), 403

    if not db_ok:
        item = memory_update_request(req_id, user, new_status, bank_note)
        if not item:
            return jsonify({"ok": False, "error": "Active request not found for your banker faction"}), 404
        return jsonify({"ok": True, "item": item, "removed_from_active": not item.get("is_active", True), "mode": "memory", "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT *
                FROM banker_requests
                WHERE id = %s
                  AND faction_id = ANY(%s)
                  AND is_active = TRUE
                """,
                (req_id, allowed_factions),
            )

            existing = cur.fetchone()

            if not existing:
                return jsonify({"ok": False, "error": "Active request not found for your banker faction"}), 404

            cur.execute(
                """
                UPDATE banker_requests
                SET status = %s,
                    handled_by_id = %s,
                    handled_by_name = %s,
                    handled_at = %s,
                    bank_note = CASE
                        WHEN %s <> '' THEN %s
                        ELSE bank_note
                    END,
                    is_active = %s
                WHERE id = %s
                RETURNING *
                """,
                (
                    new_status,
                    user["player_id"],
                    user["name"],
                    now_iso(),
                    bank_note,
                    bank_note,
                    is_active,
                    req_id,
                ),
            )

            row = cur.fetchone()

        conn.commit()

    return jsonify(
        {
            "ok": True,
            "item": row_to_item(row),
            "removed_from_active": not is_active,
        }
    )


@app.post("/api/banker/clear-completed")
def clear_completed():
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    allowed_factions = all_configured_faction_ids() if user["is_admin"] else user.get("banker_factions", [])

    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker factions configured for your account"}), 403

    if not db_ok:
        before = len(MEMORY_REQUESTS)
        MEMORY_REQUESTS[:] = [r for r in MEMORY_REQUESTS if not (r.get("faction_id") in set(allowed_factions) and not r.get("is_active", True))]
        return jsonify({"ok": True, "removed": before - len(MEMORY_REQUESTS), "mode": "memory", "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM banker_requests
                WHERE faction_id = ANY(%s)
                  AND is_active = FALSE
                """,
                (allowed_factions,),
            )

            removed = cur.rowcount

        conn.commit()

    return jsonify({"ok": True, "removed": removed})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    try:
        init_db()
    except Exception as e:
        print("DB init skipped at startup:", e)
    app.run(host="0.0.0.0", port=port)
