"""Small dependency-free cinema API and static server."""
from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import hashlib
import hmac
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DB_PATH = Path(os.environ.get("CINEMA_DB", ROOT / "data" / "cinema.sqlite3"))
TZ = ZoneInfo("Europe/Moscow")
MAX_BODY = 4096
SESSION_DAYS = 30
HOLD_MINUTES = 10
COOKIE_NAME = "ekran_session"
SOURCE = json.loads((ROOT / "kinostar_catalog.json").read_text(encoding="utf-8"))
SOURCE_MOVIES = {movie["id"]: movie for movie in SOURCE["movies"]}
TRAILERS = {movie["source_id"]: movie["trailer_remote"] for movie in SOURCE["movies"] if movie["trailer_remote"]}


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


def init_db() -> None:
    with closing(connect()) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS cinemas (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
                hall TEXT NOT NULL, rows_count INTEGER NOT NULL, seats_per_row INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS movies (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL,
                duration_min INTEGER NOT NULL, age TEXT NOT NULL, theme TEXT NOT NULL,
                tagline TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seats (
                id INTEGER PRIMARY KEY, cinema_id TEXT NOT NULL REFERENCES cinemas(id),
                row_number INTEGER NOT NULL, seat_number INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('regular','sofa')),
                x REAL NOT NULL, z REAL NOT NULL, price_rub INTEGER NOT NULL,
                UNIQUE(cinema_id, row_number, seat_number)
            );
            CREATE TABLE IF NOT EXISTS schedule (
                cinema_id TEXT NOT NULL REFERENCES cinemas(id), movie_id TEXT NOT NULL REFERENCES movies(id),
                time_local TEXT NOT NULL, PRIMARY KEY(cinema_id, movie_id, time_local)
            );
            CREATE TABLE IF NOT EXISTS shows (
                id INTEGER PRIMARY KEY, cinema_id TEXT NOT NULL REFERENCES cinemas(id),
                movie_id TEXT NOT NULL REFERENCES movies(id), starts_at TEXT NOT NULL,
                UNIQUE(cinema_id, movie_id, starts_at)
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE,
                show_id INTEGER NOT NULL REFERENCES shows(id),
                seat_id INTEGER NOT NULL REFERENCES seats(id),
                customer_name TEXT NOT NULL, price_rub INTEGER NOT NULL,
                created_at TEXT NOT NULL, UNIQUE(show_id, seat_id)
            );
            CREATE TABLE IF NOT EXISTS demo_seeded (show_id INTEGER PRIMARY KEY REFERENCES shows(id));
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                password_salt BLOB NOT NULL, password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS demo_payments (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                show_id INTEGER NOT NULL REFERENCES shows(id),
                seat_id INTEGER NOT NULL REFERENCES seats(id), amount_rub INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','succeeded','declined','expired','cancelled')),
                created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
                ticket_token TEXT REFERENCES tickets(token)
            );
            CREATE INDEX IF NOT EXISTS idx_shows_cinema_time ON shows(cinema_id, starts_at);
            CREATE INDEX IF NOT EXISTS idx_tickets_show ON tickets(show_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_payments_seat ON demo_payments(show_id,seat_id,status);
        """)
        ticket_columns = {row[1] for row in db.execute("PRAGMA table_info(tickets)")}
        if "user_id" not in ticket_columns:
            db.execute("ALTER TABLE tickets ADD COLUMN user_id INTEGER REFERENCES users(id)")
        if db.execute("SELECT COUNT(*) FROM cinemas").fetchone()[0] == 0:
            seed = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
            db.execute("BEGIN IMMEDIATE")
            try:
                for movie in seed["movies"]:
                    db.execute("INSERT INTO movies VALUES (?,?,?,?,?,?,?)", tuple(movie[k] for k in ("id", "title", "genre", "duration_min", "age", "theme", "tagline")))
                for cinema in seed["cinemas"]:
                    cid, rows, per_row = cinema["id"], cinema["rows"], cinema["seats_per_row"]
                    db.execute("INSERT INTO cinemas VALUES (?,?,?,?,?,?)", (cid, cinema["name"], cinema["address"], cinema["hall"], rows, per_row))
                    for row in range(1, rows + 1):
                        is_sofa = row == rows
                        count = cinema["sofas"] if is_sofa else per_row
                        for number in range(1, count + 1):
                            x = (number - (count + 1) / 2) * (1.65 if is_sofa else 0.82)
                            price = cinema["prices"]["sofa" if is_sofa else "front" if row <= 3 else "middle"]
                            db.execute("INSERT INTO seats(cinema_id,row_number,seat_number,kind,x,z,price_rub) VALUES (?,?,?,?,?,?,?)", (cid, row, number, "sofa" if is_sofa else "regular", x, 3.5 + row * 1.35, price))
                    for item in cinema["schedule"]:
                        for time_local in item["times"]:
                            db.execute("INSERT INTO schedule VALUES (?,?,?)", (cid, item["movie"], time_local))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        sync_kinostar(db)
        ensure_schedule(db)


def sync_kinostar(db: sqlite3.Connection) -> None:
    """Keep the source playbill available without deleting previously issued demo tickets."""
    cinema = SOURCE["cinema"]
    cid = cinema["id"]
    db.execute("""INSERT INTO cinemas VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,address=excluded.address,hall=excluded.hall""",
        (cid, cinema["name"], cinema["address"], cinema["hall"], cinema["rows"], cinema["seats_per_row"]))
    for row in range(1, cinema["rows"] + 1):
        is_sofa = row == cinema["rows"]
        count = cinema["sofas"] if is_sofa else cinema["seats_per_row"]
        for number in range(1, count + 1):
            x = (number - (count + 1) / 2) * (1.65 if is_sofa else .82)
            price = cinema["prices"]["sofa" if is_sofa else "front" if row <= 3 else "middle"]
            db.execute("""INSERT OR IGNORE INTO seats(cinema_id,row_number,seat_number,kind,x,z,price_rub)
                VALUES (?,?,?,?,?,?,?)""", (cid, row, number, "sofa" if is_sofa else "regular", x, 3.5 + row * 1.35, price))
    for movie in SOURCE["movies"]:
        db.execute("""INSERT INTO movies VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,genre=excluded.genre,duration_min=excluded.duration_min,
            age=excluded.age,theme=excluded.theme,tagline=excluded.tagline""",
            tuple(movie[k] for k in ("id", "title", "genre", "duration_min", "age", "theme", "tagline")))
        for time_local in movie["times"]:
            db.execute("INSERT OR IGNORE INTO schedule VALUES (?,?,?)", (cid, movie["id"], time_local))


def ensure_schedule(db: sqlite3.Connection) -> None:
    """Materialize rolling show times without modifying earlier purchases."""
    today = datetime.now(TZ).date()
    schedule = db.execute("SELECT cinema_id,movie_id,time_local FROM schedule").fetchall()
    for day_offset in range(14):
        date = today + timedelta(days=day_offset)
        for item in schedule:
            stamp = f"{date.isoformat()}T{item['time_local']}:00"
            if datetime.fromisoformat(stamp).replace(tzinfo=TZ) <= datetime.now(TZ) + timedelta(minutes=20):
                continue
            db.execute("INSERT OR IGNORE INTO shows(cinema_id,movie_id,starts_at) VALUES (?,?,?)", (item["cinema_id"], item["movie_id"], stamp))
    seed_demo_audience(db)


def seed_demo_audience(db: sqlite3.Connection) -> None:
    """Keep the map and the 3D audience consistent in demo showings."""
    missing = db.execute("""SELECT sh.id, sh.cinema_id FROM shows sh
        LEFT JOIN demo_seeded done ON done.show_id=sh.id WHERE done.show_id IS NULL""").fetchall()
    for show in missing:
        rows = db.execute("SELECT rows_count,seats_per_row FROM cinemas WHERE id=?", (show["cinema_id"],)).fetchone()
        center = rows["seats_per_row"] // 2
        positions = [(2, 3), (3, center + 2), (4, 2), (5, center - 1), (6, center + 1), (min(7, rows["rows_count"] - 1), rows["seats_per_row"] - 2)]
        for row_number, seat_number in positions:
            seat = db.execute("SELECT id,price_rub FROM seats WHERE cinema_id=? AND row_number=? AND seat_number=?", (show["cinema_id"], row_number, seat_number)).fetchone()
            if seat:
                db.execute("""INSERT OR IGNORE INTO tickets(token,show_id,seat_id,customer_name,price_rub,created_at)
                    VALUES (?,?,?,?,?,?)""", (secrets.token_urlsafe(24), show["id"], seat["id"], "Зритель", seat["price_rub"], datetime.now(TZ).isoformat()))
        db.execute("INSERT INTO demo_seeded(show_id) VALUES (?)", (show["id"],))


def catalog() -> dict:
    with closing(connect()) as db:
        ensure_schedule(db)
        cinemas = [dict(r) for r in db.execute("SELECT * FROM cinemas WHERE id=?", (SOURCE["cinema"]["id"],))]
        movies = [{**dict(r), **SOURCE_MOVIES[r["id"]]} for r in db.execute(
            "SELECT * FROM movies WHERE id LIKE 'ks-%' ORDER BY title") if r["id"] in SOURCE_MOVIES]
        now = datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S")
        shows = [dict(r) for r in db.execute("SELECT id,cinema_id,movie_id,starts_at FROM shows WHERE cinema_id=? AND starts_at > ? AND starts_at < ? ORDER BY starts_at", (SOURCE["cinema"]["id"], now, (datetime.now(TZ) + timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%S")))]
    return {"cinemas": cinemas, "movies": movies, "shows": shows, "server_time": now,
            "source_date": SOURCE["snapshot_date"], "schedule_demo": True}


def show_details(show_id: int) -> dict | None:
    with closing(connect()) as db:
        expire_payments(db)
        show = db.execute("SELECT id,cinema_id,movie_id,starts_at FROM shows WHERE id=?", (show_id,)).fetchone()
        if not show:
            return None
        seats = [dict(r) for r in db.execute("""SELECT s.id,s.row_number,s.seat_number,s.kind,s.x,s.z,s.price_rub,
            (t.id IS NOT NULL OR EXISTS(SELECT 1 FROM demo_payments p WHERE p.seat_id=s.id AND p.show_id=? AND p.status='pending')) AS occupied
            FROM seats s LEFT JOIN tickets t ON t.seat_id=s.id AND t.show_id=?
            WHERE s.cinema_id=? ORDER BY s.row_number,s.seat_number""", (show_id, show_id, show["cinema_id"]))]
    return {"show": dict(show), "seats": seats}


def create_order(show_id: int, seat_id: int, name: str) -> tuple[int, dict]:
    name = name.strip()
    if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
        return 400, {"error": "Укажите имя (до 80 символов)."}
    with closing(connect()) as db:
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT s.price_rub, sh.starts_at, s.row_number, s.seat_number
                FROM shows sh JOIN seats s ON s.cinema_id=sh.cinema_id
                WHERE sh.id=? AND s.id=?""", (show_id, seat_id)).fetchone()
            if row is None:
                db.execute("ROLLBACK")
                return 404, {"error": "Сеанс или место не найдены."}
            if datetime.fromisoformat(row["starts_at"]).replace(tzinfo=TZ) <= datetime.now(TZ):
                db.execute("ROLLBACK")
                return 409, {"error": "Этот сеанс уже начался."}
            token = secrets.token_urlsafe(24)
            db.execute("INSERT INTO tickets(token,show_id,seat_id,customer_name,price_rub,created_at) VALUES (?,?,?,?,?,?)", (token, show_id, seat_id, name, row["price_rub"], datetime.now(TZ).isoformat()))
            db.execute("COMMIT")
            return 201, {"token": token}
        except sqlite3.IntegrityError:
            db.execute("ROLLBACK")
            return 409, {"error": "Это место уже куплено. Выберите другое."}


def ticket_details(token: str) -> dict | None:
    with closing(connect()) as db:
        row = db.execute("""SELECT t.token,t.customer_name,t.price_rub,t.created_at,
            sh.starts_at,m.title AS movie_title,m.duration_min AS movie_duration_min,
            c.name AS cinema_name,c.address,c.hall,
            s.row_number,s.seat_number,s.kind
            FROM tickets t JOIN shows sh ON sh.id=t.show_id
            JOIN movies m ON m.id=sh.movie_id JOIN cinemas c ON c.id=sh.cinema_id
            JOIN seats s ON s.id=t.seat_id WHERE t.token=?""", (token,)).fetchone()
        return dict(row) if row else None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def expire_payments(db: sqlite3.Connection) -> None:
    db.execute("UPDATE demo_payments SET status='expired' WHERE status='pending' AND expires_at<=?", (stamp(utc_now()),))


def password_digest(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)


def register_user(email: str, name: str, password: str) -> tuple[int, dict]:
    email, name = email.strip().lower(), name.strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        return 400, {"error": "Укажите корректный email."}
    if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
        return 400, {"error": "Укажите имя (до 80 символов)."}
    if not 8 <= len(password) <= 128:
        return 400, {"error": "Пароль должен содержать от 8 до 128 символов."}
    salt = secrets.token_bytes(16)
    with closing(connect()) as db:
        try:
            cursor = db.execute("INSERT INTO users(email,name,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)",
                                (email, name, salt, password_digest(password, salt), stamp(utc_now())))
        except sqlite3.IntegrityError:
            return 409, {"error": "Этот email уже зарегистрирован."}
        return 201, {"id": cursor.lastrowid, "email": email, "name": name}


def login_user(email: str, password: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        row = db.execute("SELECT * FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
        if not row or not hmac.compare_digest(password_digest(password, row["password_salt"]), row["password_hash"]):
            return 401, {"error": "Неверный email или пароль."}
        return 200, {"id": row["id"], "email": row["email"], "name": row["name"]}


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with closing(connect()) as db:
        db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
                   (hashlib.sha256(token.encode()).hexdigest(), user_id, stamp(utc_now() + timedelta(days=SESSION_DAYS))))
    return token


def user_from_token(token: str | None) -> dict | None:
    if not token:
        return None
    with closing(connect()) as db:
        row = db.execute("""SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>?""", (hashlib.sha256(token.encode()).hexdigest(), stamp(utc_now()))).fetchone()
        return dict(row) if row else None


def delete_session(token: str | None) -> None:
    if token:
        with closing(connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))


def create_demo_payment(user_id: int, show_id: int, seat_id: int) -> tuple[int, dict]:
    with closing(connect()) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            expire_payments(db)
            row = db.execute("""SELECT s.price_rub,sh.starts_at FROM shows sh
                JOIN seats s ON s.cinema_id=sh.cinema_id WHERE sh.id=? AND s.id=?""", (show_id, seat_id)).fetchone()
            if not row:
                return 404, {"error": "Сеанс или место не найдены."}
            if datetime.fromisoformat(row["starts_at"]).replace(tzinfo=TZ) <= datetime.now(TZ):
                return 409, {"error": "Этот сеанс уже начался."}
            taken = db.execute("""SELECT 1 FROM tickets WHERE show_id=? AND seat_id=? UNION ALL
                SELECT 1 FROM demo_payments WHERE show_id=? AND seat_id=? AND status='pending' LIMIT 1""",
                (show_id, seat_id, show_id, seat_id)).fetchone()
            if taken:
                return 409, {"error": "Место уже занято или ожидает оплату. Выберите другое."}
            now = utc_now()
            payment_id = secrets.token_urlsafe(18)
            expires_at = stamp(now + timedelta(minutes=HOLD_MINUTES))
            db.execute("""INSERT INTO demo_payments(id,user_id,show_id,seat_id,amount_rub,status,created_at,expires_at)
                VALUES (?,?,?,?,?,'pending',?,?)""", (payment_id, user_id, show_id, seat_id, row["price_rub"], stamp(now), expires_at))
            db.execute("COMMIT")
            return 201, {"payment_id": payment_id, "amount_rub": row["price_rub"], "expires_at": expires_at, "status": "pending"}
        finally:
            if db.in_transaction:
                db.execute("ROLLBACK")


def finish_demo_payment(user_id: int, payment_id: str, test_card: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            expire_payments(db)
            payment = db.execute("SELECT * FROM demo_payments WHERE id=? AND user_id=?", (payment_id, user_id)).fetchone()
            if not payment:
                return 404, {"error": "Тестовый платёж не найден."}
            if payment["status"] == "succeeded":
                return 200, {"status": "succeeded", "token": payment["ticket_token"]}
            if payment["status"] != "pending":
                return 409, {"error": "Время оплаты истекло. Выберите место заново."}
            card = re.sub(r"[ -]", "", test_card)
            if card not in ("4242424242424242", "4000000000000002"):
                return 400, {"error": "Используйте только указанные тестовые номера карт."}
            if card == "4000000000000002":
                db.execute("UPDATE demo_payments SET status='declined' WHERE id=?", (payment_id,))
                db.execute("COMMIT")
                return 402, {"error": "Тестовая оплата отклонена. Деньги не списаны."}
            user = db.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()
            token = secrets.token_urlsafe(24)
            try:
                db.execute("""INSERT INTO tickets(token,show_id,seat_id,customer_name,price_rub,created_at,user_id)
                    VALUES (?,?,?,?,?,?,?)""", (token, payment["show_id"], payment["seat_id"], user["name"],
                    payment["amount_rub"], stamp(utc_now()), user_id))
            except sqlite3.IntegrityError:
                return 409, {"error": "Место уже занято. Выберите другое."}
            db.execute("UPDATE demo_payments SET status='succeeded',ticket_token=? WHERE id=?", (token, payment_id))
            db.execute("COMMIT")
            return 200, {"status": "succeeded", "token": token}
        finally:
            if db.in_transaction:
                db.execute("ROLLBACK")


def cancel_demo_payment(user_id: int, payment_id: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        cursor = db.execute("UPDATE demo_payments SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'",
                            (payment_id, user_id))
        return (200, {"status": "cancelled"}) if cursor.rowcount else (404, {"error": "Активный платёж не найден."})


def user_tickets(user_id: int) -> list[dict]:
    with closing(connect()) as db:
        tokens = [r[0] for r in db.execute("SELECT token FROM tickets WHERE user_id=? ORDER BY id DESC", (user_id,))]
    return [ticket_details(token) for token in tokens]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        message = format % args
        message = re.sub(r"/api/tickets/[A-Za-z0-9_-]+", "/api/tickets/[redacted]", message)
        super().log_message("%s", message)

    def session_token(self) -> str | None:
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
        except Exception:
            return None

    def current_user(self) -> dict | None:
        return user_from_token(self.session_token())

    def cookie_header(self, token: str | None) -> str:
        secure = "; Secure" if os.environ.get("COOKIE_SECURE") == "1" else ""
        if token:
            return f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_DAYS * 86400}{secure}"
        return f"{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}"

    def send_json(self, status: int, value: dict, cookie: str | None = None) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(200, {"status": "ok"})
        if path == "/api/catalog":
            return self.send_json(200, catalog())
        if path == "/api/auth/me":
            return self.send_json(200, {"user": self.current_user()})
        if path == "/api/me/tickets":
            user = self.current_user()
            return self.send_json(200, {"tickets": user_tickets(user["id"])}) if user else self.send_json(401, {"error": "Войдите в аккаунт."})
        match = re.fullmatch(r"/api/trailers/(\d+)\.mp4", path)
        if match:
            remote = TRAILERS.get(match.group(1))
            return self.stream_trailer(remote) if remote else self.send_json(404, {"error": "У этого фильма нет трейлера в афише."})
        match = re.fullmatch(r"/api/shows/(\d+)", path)
        if match:
            result = show_details(int(match.group(1)))
            return self.send_json(200, result) if result else self.send_json(404, {"error": "Сеанс не найден."})
        match = re.fullmatch(r"/api/tickets/([A-Za-z0-9_-]{20,64})", path)
        if match:
            result = ticket_details(match.group(1))
            return self.send_json(200, result) if result else self.send_json(404, {"error": "Билет не найден."})
        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Адрес не найден."})
        file_name = "index.html" if path in ("/", "/index.html") or re.fullmatch(r"/film/ks-\d+", path) else path.lstrip("/")
        file_path = (WEB / file_name).resolve()
        if not file_path.is_relative_to(WEB.resolve()) or not file_path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".webmanifest": "application/manifest+json"}.get(file_path.suffix, "application/octet-stream")
        if file_path.suffix == ".mp4" and (range_header := self.headers.get("Range")):
            requested = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            size = file_path.stat().st_size
            if not requested or not any(requested.groups()):
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            start_text, end_text = requested.groups()
            if start_text:
                start = int(start_text)
                end = min(int(end_text), size - 1) if end_text else size - 1
            else:
                length = int(end_text)
                start, end = max(0, size - length), size - 1
            if start >= size or end < start:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with file_path.open("rb") as media:
                media.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = media.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        if file_path.suffix == ".mp4":
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def stream_trailer(self, remote: str) -> None:
        """Serve the listed trailer on our origin so WebGL can use its video frames."""
        host = urlparse(remote)
        if host.scheme != "https" or host.hostname not in ("s1ru1.kinoplan24.ru", "s2ru1.kinoplan24.ru"):
            return self.send_json(502, {"error": "Источник трейлера недоступен."})
        headers = {"User-Agent": "Mozilla/5.0"}
        if range_header := self.headers.get("Range"):
            if not re.fullmatch(r"bytes=\d*-\d*", range_header):
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            headers["Range"] = range_header
        headers_sent = False
        try:
            with urlopen(Request(remote, headers=headers), timeout=20) as upstream:
                status = upstream.status
                self.send_response(status)
                self.send_header("Content-Type", "video/mp4")
                for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
                    if value := upstream.headers.get(name):
                        self.send_header(name, value)
                self.send_header("Cache-Control", "public, max-age=3600")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                headers_sent = True
                while chunk := upstream.read(64 * 1024):
                    self.wfile.write(chunk)
        except (OSError, TimeoutError):
            if not headers_sent:
                try:
                    self.send_json(502, {"error": "Не удалось загрузить трейлер."})
                except (BrokenPipeError, ConnectionResetError):
                    pass

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        allowed = {"/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/payments/create", "/api/orders"}
        payment_match = re.fullmatch(r"/api/payments/([A-Za-z0-9_-]{20,40})/(confirm|cancel)", path)
        if path not in allowed and not payment_match:
            return self.send_json(404, {"error": "Адрес не найден."})
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.send_json(403, {"error": "Запрос с другого сайта отклонён."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.send_json(413, {"error": "Слишком большой запрос."})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Неверные данные запроса."})
        if path == "/api/orders":
            return self.send_json(410, {"error": "Используйте тестовую оплату для оформления билета."})
        if path == "/api/auth/register":
            if not all(isinstance(data.get(key), str) for key in ("email", "name", "password")):
                return self.send_json(400, {"error": "Заполните имя, email и пароль."})
            status, result = register_user(data["email"], data["name"], data["password"])
            return self.send_json(status, {"user": result} if status == 201 else result,
                                  self.cookie_header(new_session(result["id"])) if status == 201 else None)
        if path == "/api/auth/login":
            if not all(isinstance(data.get(key), str) for key in ("email", "password")):
                return self.send_json(400, {"error": "Укажите email и пароль."})
            status, result = login_user(data["email"], data["password"])
            return self.send_json(status, {"user": result} if status == 200 else result,
                                  self.cookie_header(new_session(result["id"])) if status == 200 else None)
        if path == "/api/auth/logout":
            delete_session(self.session_token())
            return self.send_json(200, {"ok": True}, self.cookie_header(None))
        user = self.current_user()
        if not user:
            return self.send_json(401, {"error": "Войдите в аккаунт, чтобы оформить билет."})
        if path == "/api/payments/create":
            if type(data.get("show_id")) is not int or type(data.get("seat_id")) is not int:
                return self.send_json(400, {"error": "Выберите сеанс и место."})
            status, result = create_demo_payment(user["id"], data["show_id"], data["seat_id"])
            return self.send_json(status, result)
        if payment_match:
            payment_id, action = payment_match.groups()
            if action == "cancel":
                status, result = cancel_demo_payment(user["id"], payment_id)
            else:
                if not isinstance(data.get("test_card"), str):
                    return self.send_json(400, {"error": "Укажите тестовый номер карты."})
                status, result = finish_demo_payment(user["id"], payment_id, data["test_card"])
            return self.send_json(status, result)


def main() -> None:
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Экран: http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
