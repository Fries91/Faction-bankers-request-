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
APP_VERSION = "1.1.2-exact-status"


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

# Dynamic role mode: lets any faction use the app without hard-coded faction lists.
# By default, members with a faction role/position named Banker/Treasurer/Leader/Co-leader are treated as bankers.
# You can change this in Render with BANKER_ROLE_NAMES=Banker,Treasurer,Leader,Co-leader
BANKER_ROLE_NAMES = {
    x.strip().lower()
    for x in os.getenv("BANKER_ROLE_NAMES", "Banker,Treasurer,Leader,Co-leader,Co Leader").replace(";", ",").split(",")
    if x.strip()
}
FACTION_ROLE_BANKER_CACHE = {}
FACTION_ROLE_BANKER_TTL = int(os.getenv("FACTION_ROLE_BANKER_TTL", "90"))

# Safety fallback: if Render Postgres/DATABASE_URL is missing or broken,
# requests still work in memory instead of crashing with HTML 500.
# Memory requests reset when Render restarts, so Postgres is still recommended.
MEMORY_REQUESTS = []
MEMORY_NEXT_ID = 1
MEMORY_MANUAL_BANKERS = {}  # faction_id -> list of manual banker dicts
MEMORY_BANKER_ROLE_NAMES = {}  # faction_id -> list of role names leaders entered

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

def clean_pushover_key(value):
    return str(value or "").strip()[:128]

def normalize_manual_banker(item):
    if not isinstance(item, dict):
        return None
    bid = str(item.get("banker_id") or item.get("id") or item.get("player_id") or "").strip()
    if not bid:
        return None
    name = str(item.get("banker_name") or item.get("name") or bid).strip()
    return {
        "id": bid,
        "player_id": bid,
        "name": name,
        "banker_id": bid,
        "banker_name": name,
        "pushover_key": clean_pushover_key(item.get("pushover_key") or item.get("pushover") or ""),
        "source": "leaders",
    }

def env_manual_bankers_for_faction(faction_id):
    """Optional Render env fallback. Format:
    MANUAL_BANKERS={"12345":[{"id":"3679030","name":"Fries91","pushover_key":"..."}]}
    """
    fid = str(faction_id or "").strip()
    raw = os.getenv("MANUAL_BANKERS", "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        rows = data.get(fid) or data.get("default") or []
        out = []
        for row in rows:
            norm = normalize_manual_banker(row)
            if norm and not is_hidden_banker_name_or_id(norm.get("id")) and not is_hidden_banker_name_or_id(norm.get("name")):
                out.append(norm)
        return out
    except Exception as e:
        print("MANUAL_BANKERS env parse failed:", e)
        return []

def manual_bankers_for_faction(faction_id):
    fid = str(faction_id or "").strip()
    if not fid:
        return []

    # Memory fallback first when DB is unavailable.
    mem = [x for x in MEMORY_MANUAL_BANKERS.get(fid, []) if not is_hidden_banker_name_or_id(x.get("id")) and not is_hidden_banker_name_or_id(x.get("name"))]

    db_items = []
    if DATABASE_URL:
        try:
            init_db()
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT banker_id, banker_name, pushover_key
                        FROM faction_manual_bankers
                        WHERE faction_id = %s AND is_active = TRUE
                        ORDER BY banker_name ASC
                        """,
                        (fid,),
                    )
                    for row in cur.fetchall():
                        norm = normalize_manual_banker(row)
                        if norm and not is_hidden_banker_name_or_id(norm.get("id")) and not is_hidden_banker_name_or_id(norm.get("name")):
                            db_items.append(norm)
        except Exception as e:
            print("Manual banker DB lookup failed; using memory/env:", e)

    # Env fallback allows pre-seeding without UI.
    env_items = env_manual_bankers_for_faction(fid)

    seen = set()
    out = []
    for item in db_items + mem + env_items:
        bid = str(item.get("id") or "").strip()
        if bid and bid not in seen:
            seen.add(bid)
            out.append(item)
    return out

def manual_banker_ids_for_faction(faction_id):
    return [str(x.get("id")) for x in manual_bankers_for_faction(faction_id) if x.get("id")]

def manual_banker_name_for_id(faction_id, banker_id):
    bid = str(banker_id or "").strip()
    for item in manual_bankers_for_faction(faction_id):
        if str(item.get("id")) == bid:
            return str(item.get("name") or bid).strip()
    return ""

def manual_pushover_keys_for_request(item):
    fid = str(item.get("faction_id") or "").strip()
    selected = str(item.get("selected_banker_id") or "").strip()
    rows = manual_bankers_for_faction(fid)
    keys = []
    for row in rows:
        if selected and str(row.get("id")) != selected:
            continue
        k = clean_pushover_key(row.get("pushover_key"))
        if k:
            keys.append(k)
    # If no selected banker key, ping every keyed manual banker.
    if selected and not keys:
        keys = [clean_pushover_key(x.get("pushover_key")) for x in rows if clean_pushover_key(x.get("pushover_key"))]
    return list(dict.fromkeys(keys))

def can_manage_leaders(user):
    if not user:
        return False
    if user.get("is_admin"):
        return True
    # Each faction manages its own Leaders tab. Leaders/co-leaders can always manage.
    # Bankers can also manage so a trusted finance team can maintain the banker list/roles.
    return bool(user.get("can_manage_leaders") or user.get("is_leader_role") or user.get("is_banker"))


def clean_role_name(value):
    return str(value or "").strip().lower().replace("_", " ").replace("-", " ")

def banker_role_names_for_faction(faction_id):
    """Return role names that should count as bankers for this faction.

    Leaders can add these in the Leaders tab. If none are saved, the Render
    BANKER_ROLE_NAMES env var is used as the default.
    """
    fid = str(faction_id or "").strip()
    roles = []

    # Memory fallback first.
    for role in MEMORY_BANKER_ROLE_NAMES.get(fid, []):
        role = str(role or "").strip()
        if role and role not in roles:
            roles.append(role)

    # Database saved faction roles.
    if DATABASE_URL:
        try:
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT role_name
                        FROM faction_banker_roles
                        WHERE faction_id = %s
                          AND is_active = TRUE
                        ORDER BY role_name ASC
                        """,
                        (fid,),
                    )
                    for row in cur.fetchall():
                        role = str(row.get("role_name") or "").strip()
                        if role and role not in roles:
                            roles.append(role)
        except Exception as e:
            print("Faction banker role DB lookup failed; using memory/env:", e)

    if not roles:
        roles = sorted(BANKER_ROLE_NAMES)

    return roles


def is_banker_role(value, faction_id=None):
    role = clean_role_name(value)
    if not role:
        return False
    allowed = banker_role_names_for_faction(faction_id) if faction_id else BANKER_ROLE_NAMES
    return role in {clean_role_name(x) for x in allowed}

def member_position(member):
    if not isinstance(member, dict):
        return ""
    # Torn responses have varied over time/scripts; accept common role/position keys.
    for key in ("position", "role", "rank", "title", "faction_position", "faction_role"):
        val = member.get(key)
        if val:
            return str(val)
    return ""


def is_leader_like_role(value):
    role = clean_role_name(value)
    if not role:
        return False
    leader_terms = {"leader", "co leader", "co-leader", "coleader", "deputy", "deputy leader", "owner"}
    return role in leader_terms or "leader" in role or role in {"co", "co leader"}


def torn_get_member_role_for_user(key, faction_id, player_id):
    """Best-effort read of the logged-in user's faction role/position.

    Used so every faction has its own Leaders tab that its leader/co-leader can manage.
    If Torn/API does not expose the role with the user's key, we simply return ''.
    """
    fid = str(faction_id or "").strip()
    pid = str(player_id or "").strip()
    if not key or not pid:
        return ""
    urls = []
    if fid:
        urls.append(f"{TORN_API_BASE}/faction/{fid}?selections=members&key={key}")
    urls.append(f"{TORN_API_BASE}/faction/?selections=members&key={key}")
    for url in urls:
        try:
            r = requests.get(url, timeout=REQUEST_TIMEOUT)
            data = r.json()
        except Exception:
            continue
        if not isinstance(data, dict) or data.get("error"):
            continue
        for member in parse_faction_members_payload(data):
            mid = str(member.get("player_id") or member.get("id") or "").strip()
            if mid == pid:
                return member_position(member)
    return ""

def parse_faction_members_payload(data):
    members = data.get("members") if isinstance(data, dict) else None
    if isinstance(members, dict):
        out = []
        for mid, info in members.items():
            info = info if isinstance(info, dict) else {}
            item = dict(info)
            item["player_id"] = str(item.get("player_id") or item.get("id") or mid).strip()
            item["name"] = str(item.get("name") or item.get("player_name") or item.get("player_id") or mid).strip()
            out.append(item)
        return out
    if isinstance(members, list):
        out = []
        for info in members:
            if not isinstance(info, dict):
                continue
            item = dict(info)
            item["player_id"] = str(item.get("player_id") or item.get("id") or item.get("xid") or "").strip()
            item["name"] = str(item.get("name") or item.get("player_name") or item.get("player_id") or "").strip()
            if item["player_id"]:
                out.append(item)
        return out
    return []

def torn_get_role_bankers(key, faction_id):
    """Return bankers detected from the user's faction member roles.

    This is what makes the app work for any faction: no fixed Wrath/Sloth/Greed/Pride list needed.
    It looks for members whose faction position/role matches BANKER_ROLE_NAMES.
    """
    fid = str(faction_id or "").strip()
    cache_key = f"rolebankers:{fid}:{key[-6:] if key else ''}"
    cached = FACTION_ROLE_BANKER_CACHE.get(cache_key)
    if cached and time.time() - cached.get("ts", 0) < FACTION_ROLE_BANKER_TTL:
        return cached.get("items", [])

    items = []
    if key:
        urls = []
        if fid:
            urls.append(f"{TORN_API_BASE}/faction/{fid}?selections=basic&key={key}")
        urls.append(f"{TORN_API_BASE}/faction/?selections=basic&key={key}")

        for url in urls:
            try:
                r = requests.get(url, timeout=REQUEST_TIMEOUT)
                data = r.json()
                if not isinstance(data, dict) or data.get("error"):
                    continue
                for member in parse_faction_members_payload(data):
                    pos = member_position(member)
                    if is_banker_role(pos, fid):
                        pid = str(member.get("player_id") or "").strip()
                        name = str(member.get("name") or pid).strip()
                        if pid and not is_hidden_banker_name_or_id(pid) and not is_hidden_banker_name_or_id(name):
                            items.append({"id": pid, "name": name, "role": pos})
                if items:
                    break
            except Exception as e:
                print("Role banker lookup failed:", e)

    # Fries91/admin fallback only for the configured Fries91 faction(s).
    # This prevents other factions from seeing/pinging Fries unless they manually add him.
    if should_ping_global_pushover_for_faction(fid) and ADMIN_PLAYER_ID and not any(str(x.get("id")) == ADMIN_PLAYER_ID for x in items):
        items.insert(0, {"id": ADMIN_PLAYER_ID, "name": "Fries91", "role": "Admin"})

    # Keep unique by ID while preserving order.
    seen = set()
    unique = []
    for item in items:
        pid = str(item.get("id") or "").strip()
        if pid and pid not in seen:
            seen.add(pid)
            unique.append(item)

    FACTION_ROLE_BANKER_CACHE[cache_key] = {"ts": time.time(), "items": unique}
    return unique

def dynamic_banker_ids_for_faction(key, faction_id):
    manual = manual_banker_ids_for_faction(faction_id)
    role = [str(x.get("id")) for x in torn_get_role_bankers(key, faction_id) if x.get("id")]
    return list(dict.fromkeys(manual + role))

def dynamic_banker_name_for_id(key, faction_id, banker_id):
    bid = str(banker_id or "").strip()
    manual_name = manual_banker_name_for_id(faction_id, bid)
    if manual_name:
        return manual_name
    for item in torn_get_role_bankers(key, faction_id):
        if str(item.get("id")) == bid:
            return str(item.get("name") or bid).strip()
    return banker_name_from_config(faction_id, bid)


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
    """
    Turn Torn's user status payload into banker availability.

    Important: last_action.status can say Online even when a player is
    hospital/jail/traveling/abroad. So blocked states are checked FIRST,
    and activity is only used after we know they are actually in Torn.
    """
    status_obj = data.get("status") if isinstance(data, dict) else {}
    last_action = data.get("last_action") if isinstance(data, dict) else {}
    travel = data.get("travel") if isinstance(data, dict) else {}

    state = "Unknown"
    details = ""
    torn_color = ""

    if isinstance(status_obj, dict):
        state = str(status_obj.get("state") or "Unknown").strip()
        details = str(status_obj.get("details") or state).strip()
        torn_color = str(status_obj.get("color") or "").strip().lower()
    elif status_obj:
        details = str(status_obj).strip()
        state = details

    last_status = ""
    last_relative = ""
    if isinstance(last_action, dict):
        last_status = str(last_action.get("status") or "").strip()
        last_relative = str(last_action.get("relative") or "").strip()

    travel_parts = []
    travel_state = ""
    travel_dest = ""
    travel_time = ""
    if isinstance(travel, dict) and travel:
        travel_state = str(travel.get("status") or travel.get("state") or travel.get("phase") or "").strip()
        travel_dest = str(travel.get("destination") or travel.get("dest") or travel.get("country") or "").strip()
        travel_time = str(travel.get("timestamp") or travel.get("time_left") or travel.get("timeleft") or travel.get("eta") or "").strip()
        for part in (travel_state, travel_dest, travel_time):
            if part:
                travel_parts.append(part)

    # Check Torn state/travel first. Do NOT include last_action here because
    # last_action often says Online while the user is unavailable.
    blocked_text = " ".join([state, details, torn_color, " ".join(travel_parts)]).lower()
    activity_text = " ".join([last_status, last_relative]).lower()

    def has_any(text, words):
        return any(w in text for w in words)

    if has_any(blocked_text, ["hospital", "hosp"]):
        app_status = "hospital"
        app_color = "red"
        app_label = "Hospital"
    elif has_any(blocked_text, ["jail", "jailed"]):
        app_status = "jail"
        app_color = "red"
        app_label = "Jail"
    elif has_any(blocked_text, ["abroad", "overseas"]):
        app_status = "abroad"
        app_color = "blue"
        app_label = "Abroad"
    elif has_any(blocked_text, ["travel", "traveling", "travelling", "flying", "flight", "returning", "departed", "arriving"]):
        app_status = "traveling"
        app_color = "yellow"
        app_label = "Traveling"
    elif travel_dest and travel_dest.lower() not in {"torn", "home", "", "none", "null"}:
        # Some Torn responses only expose a destination/time without a plain
        # "traveling" word. Treat that as unavailable.
        app_status = "traveling"
        app_color = "yellow"
        app_label = "Traveling"
    elif "idle" in activity_text or "idle" in blocked_text or torn_color == "orange":
        app_status = "idle"
        app_color = "orange"
        app_label = "Idle"
    elif "online" in activity_text or "online" in blocked_text or torn_color == "green":
        app_status = "online"
        app_color = "green"
        app_label = "Online"
    elif "offline" in activity_text or "offline" in blocked_text or torn_color == "red":
        app_status = "offline"
        app_color = "red"
        app_label = "Offline"
    else:
        app_status = "unknown"
        app_color = "gray"
        app_label = "Unknown"

    if app_status in {"traveling", "abroad"}:
        if travel_dest and travel_time:
            subtitle = f"{app_label}: {travel_dest} • {travel_time}"
        elif travel_dest:
            subtitle = f"{app_label}: {travel_dest}"
        else:
            subtitle = details or app_label
    else:
        subtitle = details or last_relative or state or app_label

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

            # Be honest about what Torn proves. A profile saying Online/Okay
            # means Torn says the player is online and not in a blocked state,
            # but it does not prove the banker is watching the app or able to pay.
            status_obj = data.get("status") if isinstance(data, dict) else {}
            last_action = data.get("last_action") if isinstance(data, dict) else {}
            raw_state = ""
            raw_details = ""
            raw_last = ""
            raw_last_rel = ""
            if isinstance(status_obj, dict):
                raw_state = str(status_obj.get("state") or "").strip()
                raw_details = str(status_obj.get("details") or "").strip()
            elif status_obj:
                raw_details = str(status_obj).strip()
            if isinstance(last_action, dict):
                raw_last = str(last_action.get("status") or "").strip()
                raw_last_rel = str(last_action.get("relative") or "").strip()

            if status in {"traveling", "abroad", "hospital", "jail"}:
                confidence = "verified_unavailable"
                verify_note = "Torn status blocks banking"
            elif status in {"online", "idle"}:
                confidence = "torn_activity"
                verify_note = "Torn reports this banker as Online/Idle and not travel/abroad/hospital/jail"
            elif status == "offline":
                confidence = "offline"
                verify_note = "Torn says offline"
            else:
                confidence = "unknown"
                verify_note = "Torn did not provide enough status detail"

            item = {
                "player_id": bid,
                "name": name,
                "status": status,
                "color": color,
                "label": label,
                "details": details or label,
                "is_available": status in {"online", "idle"},
                "checked_ts": time.time(),
                "checked_at": now_iso(),
                "confidence": confidence,
                "verify_note": verify_note,
                "raw_state": raw_state,
                "raw_details": raw_details,
                "raw_last_action": raw_last,
                "raw_last_relative": raw_last_rel,
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
                CREATE TABLE IF NOT EXISTS faction_manual_bankers (
                    faction_id TEXT NOT NULL,
                    faction_name TEXT NOT NULL DEFAULT '',
                    banker_id TEXT NOT NULL,
                    banker_name TEXT NOT NULL DEFAULT '',
                    pushover_key TEXT NOT NULL DEFAULT '',
                    added_by_id TEXT NOT NULL DEFAULT '',
                    added_by_name TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT '',
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    PRIMARY KEY (faction_id, banker_id)
                )
                """
            )

            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS faction_banker_roles (
                    faction_id TEXT NOT NULL,
                    faction_name TEXT NOT NULL DEFAULT '',
                    role_name TEXT NOT NULL,
                    added_by_id TEXT NOT NULL DEFAULT '',
                    added_by_name TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT '',
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    PRIMARY KEY (faction_id, role_name)
                )
                """
            )

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

    configured_banker_factions = banker_factions_for_player(player_id)
    role_banker_ids = set(dynamic_banker_ids_for_faction(key, faction_id))
    manual_banker_ids = set(manual_banker_ids_for_faction(faction_id))
    own_faction_role = torn_get_member_role_for_user(key, faction_id, player_id)
    leader_role = is_leader_like_role(own_faction_role)
    legacy_banker = player_id in BANKER_IDS or player_id == ADMIN_PLAYER_ID
    dynamic_role_banker = player_id in role_banker_ids
    manual_banker = player_id in manual_banker_ids

    # In dynamic/manual mode, a banker handles their own faction only. Admin can see all configured groups plus own faction.
    banker_factions = sorted(set(configured_banker_factions + ([faction_id] if (legacy_banker or dynamic_role_banker or manual_banker) else [])))

    user = {
        "player_id": player_id,
        "name": name,
        "faction_id": faction_id,
        "faction_name": faction_name,
        "faction_role": own_faction_role,
        "is_leader_role": leader_role,
        "is_admin": player_id == ADMIN_PLAYER_ID,
        "is_banker": bool(banker_factions) or legacy_banker or dynamic_role_banker or manual_banker,
        "banker_factions": banker_factions,
    }
    user["can_manage_leaders"] = bool(user["is_admin"] or leader_role or user["is_banker"])

    return user, None


def require_user():
    key = get_key()
    user, err = torn_get_user(key)

    if err:
        return None, jsonify({"ok": False, "error": err}), 401

    return user, None, None


def public_base_url():
    return os.getenv("PUBLIC_BASE_URL", "https://faction-bankers-request.onrender.com").rstrip("/")


def pushover_api_token():
    """Allow a few common Render env names so one typo does not kill phone pings."""
    return (
        os.getenv("PUSHOVER_API_TOKEN", "").strip()
        or os.getenv("PUSHOVER_APP_TOKEN", "").strip()
        or os.getenv("PUSHOVER_TOKEN", "").strip()
    )


def mask_key(value):
    key = clean_pushover_key(value)
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"


def configured_pushover_keys():
    """Collect all global phone keys from Render env vars.

    Supported env vars:
      PUSHOVER_USER_KEY=one_key
      PUSHOVER_USER_KEYS=key1,key2,key3
      PUSHOVER_BANKER_KEYS=key1,key2,key3
      PUSHOVER_FRIES_KEY=one_key
    """
    keys = []
    for env_name in ("PUSHOVER_USER_KEY", "PUSHOVER_FRIES_KEY"):
        k = clean_pushover_key(os.getenv(env_name, ""))
        if k:
            keys.append(k)

    for env_name in ("PUSHOVER_USER_KEYS", "PUSHOVER_BANKER_KEYS"):
        raw = os.getenv(env_name, "")
        for part in str(raw).replace("\n", ",").split(","):
            k = clean_pushover_key(part)
            if k:
                keys.append(k)

    out = []
    seen = set()
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def pushover_configured():
    return bool(pushover_api_token() and configured_pushover_keys())


def fries91_notify_faction_ids():
    """Factions where global Fries91/Render Pushover keys should be pinged.

    Default is Wrath/7DS*: Wrath (49384). Other factions only ping their own
    manually saved banker Pushover keys from the Leaders tab.
    Override with FRIES91_NOTIFY_FACTION_IDS or GLOBAL_PUSHOVER_FACTION_IDS.
    Use "*" only if you intentionally want Fries pinged for every faction.
    """
    raw = (os.getenv("FRIES91_NOTIFY_FACTION_IDS", "") or os.getenv("GLOBAL_PUSHOVER_FACTION_IDS", "") or "49384")
    return {x.strip() for x in str(raw).replace("\n", ",").split(",") if x.strip()}


def should_ping_global_pushover_for_faction(faction_id):
    ids = fries91_notify_faction_ids()
    fid = str(faction_id or "").strip()
    return "*" in ids or fid in ids


def send_pushover_to_key_detailed(user_key, title, message, url=None):
    api_token = pushover_api_token()
    user_key = clean_pushover_key(user_key)

    if not api_token:
        return {"ok": False, "error": "Missing PUSHOVER_API_TOKEN in Render env vars"}
    if not user_key:
        return {"ok": False, "error": "Missing Pushover user key"}

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
        response = requests.post("https://api.pushover.net/1/messages.json", data=payload, timeout=12)
        text = response.text[:500]
        print("Pushover:", response.status_code, text)
        return {
            "ok": bool(response.ok),
            "status_code": response.status_code,
            "response": text,
            "user_key": mask_key(user_key),
        }
    except Exception as e:
        print("Pushover error:", e)
        return {"ok": False, "error": str(e), "user_key": mask_key(user_key)}


def send_pushover_to_key(user_key, title, message, url=None):
    return bool(send_pushover_to_key_detailed(user_key, title, message, url).get("ok"))


def send_pushover_alert(title, message, url=None):
    """Send direct phone ping to every global configured Pushover key."""
    sent = False
    for key in configured_pushover_keys():
        sent = send_pushover_to_key(key, title, message, url) or sent
    return sent


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
        f"Notify: All faction bankers\n"
        f"Request ID: #{item.get('id')}"
    )

    title = "🪙 New Torn Bank Request"
    sent = False
    seen_keys = set()

    # Ping manual banker keys from the Leaders tab first.
    for k in manual_pushover_keys_for_request(item):
        if k and k not in seen_keys:
            seen_keys.add(k)
            sent = send_pushover_to_key(k, title, message, request_url) or sent

    # Ping global Render-configured Fries91 keys only for Fries91's configured faction(s).
    # Other factions only notify their own banker keys saved in the Leaders tab.
    if should_ping_global_pushover_for_faction(item.get("faction_id")):
        for k in configured_pushover_keys():
            if k and k not in seen_keys:
                seen_keys.add(k)
                sent = send_pushover_to_key(k, title, message, request_url) or sent

    return sent


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
            item["is_active"] = new_status not in {"approved", "complete", "denied"}
            return item
    return None


@app.get("/")
def home():
    return jsonify(
        {
            "ok": True,
            "app": "Faction Bankers",
            "version": "1.0.7-request-list-coin-fix",
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
                "extra_pushover_keys_configured": bool(os.getenv("PUSHOVER_BANKER_KEYS", "").strip()),
        "public_base_url": public_base_url(),
        "banker_role_names": banker_role_names_for_faction(user["faction_id"]),
        "manual_bankers_memory_count": sum(len(v) for v in MEMORY_MANUAL_BANKERS.values()),
        "manual_role_names_memory_count": sum(len(v) for v in MEMORY_BANKER_ROLE_NAMES.values()),
        "time": now_iso(),
    })


@app.get("/api/test-pushover")
def test_pushover():
    keys = configured_pushover_keys()
    token_ok = bool(pushover_api_token())
    results = []

    for key in keys:
        results.append(send_pushover_to_key_detailed(
            key,
            "🪙 Test Bank Ping",
            "Your Faction Bankers Pushover phone alert is working.",
            "https://www.torn.com/factions.php?step=your#/tab=controls",
        ))

    return jsonify({
        "ok": any(r.get("ok") for r in results),
        "pushover_configured": bool(token_ok and keys),
        "api_token_present": token_ok,
        "configured_key_count": len(keys),
        "configured_keys_masked": [mask_key(k) for k in keys],
        "results": results,
        "hint": "If ok is false, check Render env vars: PUSHOVER_API_TOKEN and PUSHOVER_USER_KEY. If status_code is 400, the key/token pair is wrong.",
    })


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)




def scan_json_for_balance(obj, player_id=""):
    """Strict scan for the logged-in user's own faction-bank balance.

    This intentionally does NOT use generic faction money/funds/vault values,
    because those are not the user's personal faction balance and caused false totals.
    """
    pid = str(player_id or "").strip()
    if not pid:
        return None, ""

    candidates = []

    def walk(x, path=""):
        if isinstance(x, dict):
            row_id = str(x.get("player_id") or x.get("id") or x.get("user_id") or "").strip()
            is_player_row = bool(row_id and row_id == pid)

            for k, v in x.items():
                key = str(k or "").lower()
                pth = f"{path}.{key}" if path else key

                # Only accept balance fields from the row that belongs to the logged-in player.
                if is_player_row and "balance" in key:
                    if isinstance(v, (int, float)):
                        candidates.append((100, int(v), pth))
                    elif isinstance(v, str):
                        cleaned = v.replace("$", "").replace(",", "").strip()
                        if cleaned.isdigit():
                            candidates.append((100, int(cleaned), pth))

                walk(v, pth)
        elif isinstance(x, list):
            for idx, item in enumerate(x[:1000]):
                walk(item, f"{path}[{idx}]")

    walk(obj)
    if not candidates:
        return None, ""
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1], candidates[0][2]

def torn_get_faction_balance(key, user):
    if not key:
        return None, "Missing Torn API key", ""

    faction_id = str((user or {}).get("faction_id") or "").strip()
    player_id = str((user or {}).get("player_id") or "").strip()

    urls = []
    if faction_id:
        urls.append(f"{TORN_API_BASE}/faction/{faction_id}?selections=members&key={key}")
    urls.append(f"{TORN_API_BASE}/faction/?selections=members&key={key}")

    last_error = "Your personal faction balance is unavailable with this key/page"
    for url in urls:
        try:
            r = requests.get(url, timeout=REQUEST_TIMEOUT)
            data = r.json()
        except Exception as e:
            last_error = f"Torn balance lookup failed: {e}"
            continue

        if not isinstance(data, dict):
            continue
        if data.get("error"):
            err = data.get("error") or {}
            last_error = err.get("error", "Torn API error") if isinstance(err, dict) else str(err)
            continue

        bal, source = scan_json_for_balance(data, player_id)
        if bal is not None:
            return bal, None, source or "api"

    return None, last_error, ""

@app.get("/api/banker/me")
def banker_me():
    user, resp, code = require_user()
    if resp:
        return resp, code
    return jsonify({
        "ok": True,
        "player_id": user.get("player_id"),
        "name": user.get("name"),
        "faction_id": user.get("faction_id"),
        "faction_name": user.get("faction_name"),
        "faction_role": user.get("faction_role", ""),
        "is_admin": user.get("is_admin", False),
        "is_banker": user.get("is_banker", False),
        "is_leader_role": user.get("is_leader_role", False),
        "can_manage_leaders": can_manage_leaders(user),
        "banker_factions": user.get("banker_factions", []),
        "available_factions": [{"faction_id": user.get("faction_id"), "faction_name": user.get("faction_name")}],
    })


@app.get("/api/banker/factions")
def banker_factions():
    # Dynamic mode: only show the logged-in user's own faction.
    # This removes Wrath/Sloth/Greed/Pride choices and lets any faction use the app.
    user, resp, code = require_user()
    if resp:
        return resp, code
    items = [{"faction_id": user["faction_id"], "faction_name": user["faction_name"]}]
    return jsonify({"ok": True, "items": items, "count": len(items), "mode": "dynamic_role"})


@app.get("/api/banker/balance")
def banker_balance():
    user, resp, code = require_user()
    if resp:
        return resp, code

    key = get_key()
    balance, err, source = torn_get_faction_balance(key, user)

    if balance is None:
        return jsonify({
            "ok": False,
            "balance": None,
            "message": err or "Balance unavailable with this key",
            "source": source,
        })

    return jsonify({
        "ok": True,
        "balance": int(balance),
        "source": source or "api",
        "player_id": user.get("player_id"),
        "faction_id": user.get("faction_id"),
    })


@app.get("/api/banker/status")
def banker_status():
    user, resp, code = require_user()
    if resp:
        return resp, code

    key = get_key()
    requested_faction_id = str(request.args.get("faction_id") or "").strip() or str(user.get("faction_id") or "").strip()
    faction_name = user.get("faction_name") or faction_name_for_id(requested_faction_id) or requested_faction_id or "Faction"

    # Prefer leaders-tab manual bankers. Then role-detected bankers. Then legacy config.
    # Do not globally add Fries91 for other factions unless configured in FRIES91_NOTIFY_FACTION_IDS.
    manual_bankers = []
    role_bankers = []
    banker_ids = []
    warnings = []

    try:
        manual_bankers = manual_bankers_for_faction(requested_faction_id)
    except Exception as e:
        warnings.append(f"manual banker lookup failed: {e}")
        manual_bankers = []

    if manual_bankers:
        banker_ids = [str(x.get("id") or x.get("banker_id")) for x in manual_bankers if x.get("id") or x.get("banker_id")]
    else:
        try:
            role_bankers = torn_get_role_bankers(key, requested_faction_id)
        except Exception as e:
            warnings.append(f"role banker lookup failed: {e}")
            role_bankers = []
        if role_bankers:
            banker_ids = [str(x.get("id")) for x in role_bankers if x.get("id")]
        elif requested_faction_id in FACTION_BANKERS:
            banker_ids = bankers_for_faction(requested_faction_id)
        elif should_ping_global_pushover_for_faction(requested_faction_id):
            banker_ids = sorted(BANKER_IDS or {ADMIN_PLAYER_ID})
        else:
            banker_ids = []

    manual_by_id = {str(x.get("id") or x.get("banker_id")): x for x in manual_bankers_for_faction(requested_faction_id)}
    role_by_id = {str(x.get("id")): x for x in role_bankers if x.get("id")}

    seen = set()
    items = []
    for bid in banker_ids:
        bid = str(bid or "").strip()
        if not bid or bid in seen:
            continue
        seen.add(bid)
        if is_hidden_banker_name_or_id(bid):
            continue
        try:
            st = torn_get_banker_status(key, bid, requested_faction_id)
        except Exception as e:
            st = {
                "player_id": bid,
                "name": manual_banker_name_for_id(requested_faction_id, bid) or banker_name_from_config(requested_faction_id, bid) or bid,
                "status": "unknown",
                "color": "gray",
                "label": "Status unavailable",
                "details": f"Status check failed: {e}"[:160],
                "is_available": False,
            }
        if bid in manual_by_id:
            st["source"] = "leaders"
            st["name"] = manual_by_id[bid].get("name") or manual_by_id[bid].get("banker_name") or st.get("name") or bid
            st["has_pushover"] = bool(manual_by_id[bid].get("pushover_key")) or (bid == ADMIN_PLAYER_ID and should_ping_global_pushover_for_faction(requested_faction_id))
        elif bid in role_by_id:
            st["source"] = "role"
            st["role"] = role_by_id[bid].get("role", "")
            st["has_pushover"] = (bid == ADMIN_PLAYER_ID and should_ping_global_pushover_for_faction(requested_faction_id))
        else:
            st["source"] = "config"
            st["has_pushover"] = (bid == ADMIN_PLAYER_ID and should_ping_global_pushover_for_faction(requested_faction_id))

        if not is_hidden_banker_name_or_id(st.get("player_id")) and not is_hidden_banker_name_or_id(st.get("name")):
            items.append(st)

    rank = {"online": 0, "idle": 1, "traveling": 2, "abroad": 3, "hospital": 4, "jail": 5, "offline": 6, "unknown": 7}
    items.sort(key=lambda x: (rank.get(str(x.get("status")), 9), str(x.get("name") or "").lower()))

    return jsonify({
        "ok": True,
        "faction_id": requested_faction_id,
        "faction_name": faction_name,
        "items": items,
        "count": len(items),
        "role_names": banker_role_names_for_faction(requested_faction_id),
        "manual_count": len(manual_bankers),
        "global_fries_ping_enabled": should_ping_global_pushover_for_faction(requested_faction_id),
        "warnings": warnings,
        "time": now_iso(),
    })

@app.get("/api/banker/leaders")
def get_leader_bankers():
    user, resp, code = require_user()
    if resp:
        return resp, code
    if not can_manage_leaders(user):
        return jsonify({"ok": False, "error": "Leader/banker access required"}), 403
    fid = user.get("faction_id")
    return jsonify({
        "ok": True,
        "faction_id": fid,
        "faction_name": user.get("faction_name"),
        "items": [
            {
                "banker_id": x.get("id"),
                "banker_name": x.get("name"),
                "has_pushover": bool(x.get("pushover_key")),
                "source": x.get("source", "leaders"),
            }
            for x in manual_bankers_for_faction(fid)
        ],
        "role_names": banker_role_names_for_faction(fid),
        "default_role_names": sorted(BANKER_ROLE_NAMES),
        "can_manage": True,
        "manager_role": user.get("faction_role", ""),
        "manager_name": user.get("name", ""),
    })

@app.post("/api/banker/leaders/roles/add")
def add_leader_banker_role():
    user, resp, code = require_user()
    if resp:
        return resp, code
    if not can_manage_leaders(user):
        return jsonify({"ok": False, "error": "Leader/banker access required"}), 403

    data = request.get_json(silent=True) or {}
    role_name = str(data.get("role_name") or "").strip()
    if not role_name:
        return jsonify({"ok": False, "error": "Enter the banker role name"}), 400
    if len(role_name) > 80:
        role_name = role_name[:80]

    fid = user.get("faction_id")
    fname = user.get("faction_name")

    db_ok, db_msg = db_ready()
    if db_ok:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO faction_banker_roles (
                        faction_id, faction_name, role_name, added_by_id, added_by_name, created_at, is_active
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,TRUE)
                    ON CONFLICT (faction_id, role_name) DO UPDATE SET
                        faction_name = EXCLUDED.faction_name,
                        added_by_id = EXCLUDED.added_by_id,
                        added_by_name = EXCLUDED.added_by_name,
                        created_at = EXCLUDED.created_at,
                        is_active = TRUE
                    """,
                    (fid, fname, role_name, user.get("player_id"), user.get("name"), now_iso()),
                )
            conn.commit()
    else:
        rows = MEMORY_BANKER_ROLE_NAMES.setdefault(fid, [])
        if role_name not in rows:
            rows.append(role_name)

    FACTION_ROLE_BANKER_CACHE.clear()
    BANKER_STATUS_CACHE.clear()
    return jsonify({"ok": True, "role_name": role_name, "role_names": banker_role_names_for_faction(fid), "mode": "postgres" if db_ok else "memory", "warning": "" if db_ok else db_msg})


@app.post("/api/banker/leaders/roles/remove")
def remove_leader_banker_role():
    user, resp, code = require_user()
    if resp:
        return resp, code
    if not can_manage_leaders(user):
        return jsonify({"ok": False, "error": "Leader/banker access required"}), 403

    data = request.get_json(silent=True) or {}
    role_name = str(data.get("role_name") or "").strip()
    if not role_name:
        return jsonify({"ok": False, "error": "Missing role name"}), 400

    fid = user.get("faction_id")
    db_ok, db_msg = db_ready()
    if db_ok:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE faction_banker_roles SET is_active = FALSE WHERE faction_id = %s AND role_name = %s",
                    (fid, role_name),
                )
            conn.commit()
    else:
        rows = MEMORY_BANKER_ROLE_NAMES.setdefault(fid, [])
        rows[:] = [x for x in rows if str(x) != role_name]

    FACTION_ROLE_BANKER_CACHE.clear()
    BANKER_STATUS_CACHE.clear()
    return jsonify({"ok": True, "removed": role_name, "role_names": banker_role_names_for_faction(fid), "mode": "postgres" if db_ok else "memory", "warning": "" if db_ok else db_msg})


@app.post("/api/banker/leaders/add")
def add_leader_banker():
    user, resp, code = require_user()
    if resp:
        return resp, code
    if not can_manage_leaders(user):
        return jsonify({"ok": False, "error": "Leader/banker access required"}), 403

    data = request.get_json(silent=True) or {}
    banker_id = str(data.get("banker_id") or "").replace("[", "").replace("]", "").strip()
    banker_name = str(data.get("banker_name") or banker_id).strip()
    pushover_key = clean_pushover_key(data.get("pushover_key") or "")
    if not banker_id:
        return jsonify({"ok": False, "error": "Enter the banker Torn ID"}), 400
    if len(banker_name) > 60:
        banker_name = banker_name[:60]

    fid = user.get("faction_id")
    fname = user.get("faction_name")
    item = {"id": banker_id, "name": banker_name, "pushover_key": pushover_key, "source": "leaders"}

    db_ok, db_msg = db_ready()
    if db_ok:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO faction_manual_bankers (
                        faction_id, faction_name, banker_id, banker_name, pushover_key, added_by_id, added_by_name, created_at, is_active
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,TRUE)
                    ON CONFLICT (faction_id, banker_id) DO UPDATE SET
                        faction_name = EXCLUDED.faction_name,
                        banker_name = EXCLUDED.banker_name,
                        pushover_key = EXCLUDED.pushover_key,
                        added_by_id = EXCLUDED.added_by_id,
                        added_by_name = EXCLUDED.added_by_name,
                        created_at = EXCLUDED.created_at,
                        is_active = TRUE
                    """,
                    (fid, fname, banker_id, banker_name, pushover_key, user.get("player_id"), user.get("name"), now_iso()),
                )
            conn.commit()
    else:
        rows = MEMORY_MANUAL_BANKERS.setdefault(fid, [])
        rows[:] = [x for x in rows if str(x.get("id")) != banker_id]
        rows.append(item)

    # Clear banker cache so the dropdown/status refresh immediately.
    FACTION_ROLE_BANKER_CACHE.clear()
    BANKER_STATUS_CACHE.clear()

    test_ping = False
    if pushover_key:
        test_ping = send_pushover_to_key(
            pushover_key,
            "🪙 Added as Faction Banker",
            f"{user.get('name')} added you as a banker for {fname}. You can now receive bank request pings.",
            "https://www.torn.com/factions.php?step=your#/tab=controls",
        )

    return jsonify({"ok": True, "item": item, "test_ping_sent": test_ping, "mode": "postgres" if db_ok else "memory", "warning": "" if db_ok else db_msg})

@app.post("/api/banker/leaders/remove")
def remove_leader_banker():
    user, resp, code = require_user()
    if resp:
        return resp, code
    if not can_manage_leaders(user):
        return jsonify({"ok": False, "error": "Leader/banker access required"}), 403
    data = request.get_json(silent=True) or {}
    banker_id = str(data.get("banker_id") or "").strip()
    if not banker_id:
        return jsonify({"ok": False, "error": "Missing banker ID"}), 400
    fid = user.get("faction_id")

    db_ok, db_msg = db_ready()
    if db_ok:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE faction_manual_bankers SET is_active = FALSE WHERE faction_id = %s AND banker_id = %s",
                    (fid, banker_id),
                )
            conn.commit()
    else:
        rows = MEMORY_MANUAL_BANKERS.setdefault(fid, [])
        rows[:] = [x for x in rows if str(x.get("id")) != banker_id]

    FACTION_ROLE_BANKER_CACHE.clear()
    BANKER_STATUS_CACHE.clear()
    return jsonify({"ok": True, "removed": banker_id, "mode": "postgres" if db_ok else "memory", "warning": "" if db_ok else db_msg})


@app.get("/api/banker/requests")
def list_requests():
    """List active requests visible to the logged-in user.

    v1.0.7 fix:
    - Restores the GET /api/banker/requests route used by the header coin,
      banker board, and PDA refresh. Without this, Render returned 405
      "method not allowed" and other bankers could not see pending requests.
    - Keeps faction separation: members see their own requests; bankers see
      active requests for their own banker factions; admin can see configured
      admin factions plus their own faction.
    """
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if user.get("is_admin"):
        faction_ids = sorted(set(all_configured_faction_ids() or []) | {str(user.get("faction_id") or "")})
    elif user.get("is_banker"):
        faction_ids = sorted(set(user.get("banker_factions") or [user.get("faction_id")]))
    else:
        faction_ids = []

    faction_ids = [str(x).strip() for x in faction_ids if str(x).strip()]

    if not db_ok:
        items = memory_visible_items(user)
        items = sorted(items, key=lambda r: float(r.get("created_ts") or 0), reverse=True)
        return jsonify({
            "ok": True,
            "items": items,
            "count": len(items),
            "mode": "memory",
            "warning": db_msg,
        })

    with get_db() as conn:
        with conn.cursor() as cur:
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

    return jsonify({
        "ok": True,
        "items": items,
        "count": len(items),
        "mode": "postgres",
    })

@app.get("/api/banker/requests/<int:req_id>")
def get_request(req_id):
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user.get("is_banker"):
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    allowed_factions = sorted(set((all_configured_faction_ids() if user.get("is_admin") else []) + (user.get("banker_factions", []) or [user.get("faction_id")])) )
    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker access for your faction"}), 403

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
    # v1.1.3: requests notify all faction bankers; ignore any stale preferred banker value from older userscripts.
    selected_banker_id = ""

    try:
        amount = int(str(amount).replace(",", "").replace("$", "").strip())
    except Exception:
        amount = 0

    if amount <= 0:
        return jsonify({"ok": False, "error": "Enter a valid amount"}), 400

    if len(note) > 500:
        note = note[:500]

    # Dynamic mode: requests always go to the user's own faction.
    # This removes all hard-coded faction groups and lets any faction use the same app.
    target_faction_id = user["faction_id"]
    target_faction_name = user["faction_name"]

    selected_banker_name = ""
    if selected_banker_id:
        allowed_bankers = set(dynamic_banker_ids_for_faction(get_key(), target_faction_id) or bankers_for_faction(target_faction_id))
        if selected_banker_id not in allowed_bankers:
            return jsonify({"ok": False, "error": "Selected banker is not assigned to your faction banker role"}), 400
        try:
            selected_banker_status = torn_get_banker_status(get_key(), selected_banker_id, target_faction_id)
            selected_banker_name = str(selected_banker_status.get("name") or dynamic_banker_name_for_id(get_key(), target_faction_id, selected_banker_id) or selected_banker_id).strip()
        except Exception:
            selected_banker_name = dynamic_banker_name_for_id(get_key(), target_faction_id, selected_banker_id) or selected_banker_id

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
    """Approve / deny / complete a bank request.

    v1.0.2 fix:
    - Do not accidentally block Fries91/admin from active requests.
    - Do not filter the SELECT before we know who owns the request.
    - Allow faction bankers, manual bankers, selected preferred banker, same-faction bankers, and admin.
    - Return readable JSON instead of a vague action failure.
    - Approve, complete, and deny all remove the request from the active board.
    """
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

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

    is_active = new_status not in {"approved", "complete", "denied"}

    def can_handle_request(req_item):
        req_faction = str(req_item.get("faction_id") or "").strip()
        selected_banker_id = str(req_item.get("selected_banker_id") or "").strip()
        user_id = str(user.get("player_id") or "").strip()
        user_faction = str(user.get("faction_id") or "").strip()
        user_banker_factions = {str(x).strip() for x in (user.get("banker_factions") or []) if str(x).strip()}

        if user.get("is_admin") or user_id == ADMIN_PLAYER_ID:
            return True, "admin"
        if selected_banker_id and selected_banker_id == user_id:
            return True, "selected_banker"
        if req_faction and req_faction in user_banker_factions:
            return True, "banker_faction"
        if user.get("is_banker") and req_faction and user_faction and req_faction == user_faction:
            return True, "same_faction_banker"
        if user_id in set(manual_banker_ids_for_faction(req_faction)):
            return True, "manual_banker"
        if user_id in set(dynamic_banker_ids_for_faction(get_key(), req_faction)):
            return True, "role_banker"
        return False, "not_banker_for_request"

    if not db_ok:
        # Memory fallback still checks access now, instead of failing silently.
        existing = None
        for item in MEMORY_REQUESTS:
            if int(item.get("id", 0) or 0) == int(req_id) and item.get("is_active", True):
                existing = item
                break
        if not existing:
            for item in MEMORY_REQUESTS:
                if int(item.get("id", 0) or 0) == int(req_id):
                    return jsonify({
                        "ok": True,
                        "item": item,
                        "removed_from_active": True,
                        "already_cleared": True,
                        "mode": "memory",
                        "warning": db_msg,
                    })
            return jsonify({"ok": False, "error": "Active request not found", "mode": "memory", "warning": db_msg}), 404
        allowed, reason = can_handle_request(existing)
        if not allowed:
            return jsonify({
                "ok": False,
                "error": "Banker access required for this request",
                "reason": reason,
                "request_faction_id": existing.get("faction_id"),
                "your_faction_id": user.get("faction_id"),
                "your_banker_factions": user.get("banker_factions", []),
            }), 403
        item = memory_update_request(req_id, user, new_status, bank_note)
        return jsonify({"ok": True, "item": item, "removed_from_active": not item.get("is_active", True), "mode": "memory", "access": reason, "warning": db_msg})

    with get_db() as conn:
        with conn.cursor() as cur:
            # First find the active request by ID only. Older versions filtered by allowed factions too early.
            cur.execute(
                """
                SELECT *
                FROM banker_requests
                WHERE id = %s
                  AND is_active = TRUE
                """,
                (req_id,),
            )
            existing = cur.fetchone()

            if not existing:
                # Idempotent clear: if the request was already approved/completed/denied,
                # return success so PDA/userscript can remove stale local cards.
                cur.execute(
                    """
                    SELECT *
                    FROM banker_requests
                    WHERE id = %s
                    """,
                    (req_id,),
                )
                old_row = cur.fetchone()
                if old_row:
                    return jsonify({
                        "ok": True,
                        "item": row_to_item(old_row),
                        "removed_from_active": True,
                        "already_cleared": True,
                        "message": "Request was already cleared",
                    })
                return jsonify({"ok": False, "error": "Active request not found"}), 404

            allowed, reason = can_handle_request(existing)
            if not allowed:
                return jsonify({
                    "ok": False,
                    "error": "Banker access required for this request",
                    "reason": reason,
                    "request_faction_id": existing.get("faction_id"),
                    "request_faction_name": existing.get("faction_name"),
                    "your_faction_id": user.get("faction_id"),
                    "your_faction_name": user.get("faction_name"),
                    "your_banker_factions": user.get("banker_factions", []),
                    "is_admin": user.get("is_admin", False),
                    "is_banker": user.get("is_banker", False),
                }), 403

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

    return jsonify({
        "ok": True,
        "item": row_to_item(row),
        "removed_from_active": not is_active,
        "access": reason,
    })

@app.post("/api/banker/clear-completed")
def clear_completed():
    db_ok, db_msg = db_ready()

    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    allowed_factions = sorted(set((all_configured_faction_ids() if user.get("is_admin") else []) + (user.get("banker_factions", []) or [user.get("faction_id")])) )

    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker access for your faction"}), 403

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
