import json
import os
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS


app = Flask(__name__, static_folder="static")
CORS(app)


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

    # Backwards-compatible fallback for older Render setup.
    return {
        "default": {
            "name": "Default",
            "bankers": sorted(BANKER_IDS),
        }
    }


FACTION_BANKERS = load_faction_bankers()


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


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing")

    return psycopg2.connect(
        DATABASE_URL,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


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
    }


@app.before_request
def before_request():
    init_db()


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
    try:
        init_db()

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS count FROM banker_requests WHERE is_active = TRUE")
                row = cur.fetchone()
                active_count = int(row["count"] or 0)

        return jsonify(
            {
                "ok": True,
                "app": "Faction Bankers",
                "mode": "postgres",
                "active_requests": active_count,
                "banker_ids": sorted(BANKER_IDS),
                "faction_bankers": public_factions(),
                "admin_player_id": ADMIN_PLAYER_ID,
                "time": now_iso(),
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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


@app.post("/api/banker/requests")
def create_request():
    user, resp, code = require_user()
    if resp:
        return resp, code

    data = request.get_json(silent=True) or {}

    amount = data.get("amount", 0)
    note = str(data.get("note") or "").strip()
    selected_faction_id = str(data.get("target_faction_id") or "").strip()

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

    created_at = now_iso()
    created_ts = time.time()

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
                    created_at,
                    created_ts,
                    is_active
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE)
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
                    created_at,
                    created_ts,
                ),
            )

            row = cur.fetchone()

        conn.commit()

    return jsonify(
        {
            "ok": True,
            "item": row_to_item(row),
        }
    )


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
    user, resp, code = require_user()
    if resp:
        return resp, code

    if not user["is_banker"]:
        return jsonify({"ok": False, "error": "Banker access required"}), 403

    allowed_factions = all_configured_faction_ids() if user["is_admin"] else user.get("banker_factions", [])

    if not allowed_factions:
        return jsonify({"ok": False, "error": "No banker factions configured for your account"}), 403

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
    init_db()
    app.run(host="0.0.0.0", port=port)
