import os, time
import uuid
import mimetypes
import asyncio

try:
    import redis
except Exception:
    redis = None

from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, Set, Optional

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, Request, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import shutil

from .db import init_db, connect
from .models import ScreenStateResponse, DefaultItem, DefaultsResponse
from .storage import upload_to_local  # <--- usamos siempre local para servir en screen
from .rate_limit import RateLimiter

from dotenv import load_dotenv
load_dotenv()  # <- lee backend/.env

# NEW: usamos el cliente directo de Drive para el backup
from .drive_client import get_drive_client

# ---------- Config ----------
PORT = int(os.getenv("PORT", "8000"))
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

# Mantengo STORAGE para montar estáticos, pero la subida SIEMPRE va a local para screen
STORAGE = os.getenv("STORAGE", "local").lower()  # 'local' or 'drive'
DEFAULT_IMAGE_URL = (os.getenv("DEFAULT_IMAGE_URL") or "").strip()
IMAGE_DURATION_SECONDS = int(os.getenv("IMAGE_DURATION_SECONDS", "30"))
MAX_IMAGE_MB = int(os.getenv("MAX_IMAGE_MB", "10"))
ALLOWED_MIME = [m.strip() for m in os.getenv("ALLOWED_MIME", "image/jpeg,image/png,image/webp").split(",")]

# Carrusel generado
DEFAULTS_DIR = os.getenv("DEFAULTS_DIR", "/static/defaults").rstrip("/")
DEFAULTS_PREFIX = os.getenv("DEFAULTS_PREFIX", "default_")
DEFAULTS_EXT = os.getenv("DEFAULTS_EXT", ".jpg")
DEFAULTS_PAD = int(os.getenv("DEFAULTS_PAD", "2"))
DEFAULTS_START = int(os.getenv("DEFAULTS_START", "1"))
DEFAULTS_END = int(os.getenv("DEFAULTS_END", "15"))
DEFAULTS_MS = int(os.getenv("DEFAULTS_MS", "8000"))

# Rate limit
RATE_LIMIT_UPLOADS_PER_WINDOW = int(os.getenv("RATE_LIMIT_UPLOADS_PER_WINDOW", "1"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "10"))
rate_limiter = RateLimiter(RATE_LIMIT_UPLOADS_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS)

# Local storage
LOCAL_UPLOAD_DIR = Path(os.getenv("LOCAL_UPLOAD_DIR", "uploads")).resolve()
BASE_PUBLIC_URL = "/uploads"  # servido por StaticFiles

# Drive (backup)
GOOGLE_SERVICE_ACCOUNT_JSON = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")

# Redis - Rate limit
# --- Redis opcional + fallback en memoria ---
USE_REDIS = False
r = None
if redis is not None:
    try:
        # Configurable por ENV si querés: REDIS_HOST, REDIS_PORT
        r = redis.Redis(host=os.getenv("REDIS_HOST", "localhost"),
                        port=int(os.getenv("REDIS_PORT", "6379")),
                        decode_responses=True,
                        socket_connect_timeout=0.5)
        r.ping()
        USE_REDIS = True
    except Exception:
        USE_REDIS = False

LAST_UPLOAD_TS: Dict[str, int] = {}  # fallback memoria

RATE_WINDOW = 10

def rate_limit_key(event: str, device_id: str) -> str:
    return f"photos:last:{event}:{device_id}"

def _rl_key(event: str, device_id: str) -> str:
    # reutilizamos tu misma convención
    return rate_limit_key(event, device_id)

def rate_allow_with_fallback(event: str, device_id: str, window: int):
    """
    Devuelve (allowed, remaining_secs). Usa Redis si está disponible;
    si no, usa un diccionario en memoria.
    """
    now = int(time.time())
    key = _rl_key(event, device_id)

    if USE_REDIS:
        last = r.get(key)
        if last is not None:
            last_i = int(last)
            delta = now - last_i
            if delta < window:
                return (False, window - delta)
        # set nuevo timestamp con TTL (limpia sola la clave)
        r.set(key, now, ex=window)
        return (True, 0)
    else:
        last_i = LAST_UPLOAD_TS.get(key, 0)
        delta = now - last_i
        if delta < window:
            return (False, window - delta)
        LAST_UPLOAD_TS[key] = now
        return (True, 0)
    
# --- Guardar UploadFile a disco en streaming y controlar tamaño ---
async def save_upload_streaming_strict(upload: UploadFile, dst_path: Path, *, max_mb: int) -> int:
    """
    Escribe el archivo a disco por chunks sin cargarlo completo en RAM.
    Controla MAX_IMAGE_MB. Devuelve bytes escritos.
    """
    tmp_path = dst_path.with_suffix(dst_path.suffix + ".part")
    total = 0
    limit = max_mb * 1024 * 1024
    try:
        with tmp_path.open("wb") as out:
            while True:
                chunk = await upload.read(1024 * 1024)  # 1 MB
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise HTTPException(status_code=400, detail="Archivo demasiado grande")
                out.write(chunk)
        tmp_path.rename(dst_path)
        return total
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except:
            pass
        raise
    finally:
        # Cerramos el stream del UploadFile
        try:
            await upload.close()
        except:
            pass

# Adivinar extensión desde Mime (si guess_extension falla)
def guess_ext_from_mime(mime: str) -> str:
    if mime == "image/jpeg":
        return ".jpg"
    if mime == "image/png":
        return ".png"
    if mime == "image/webp":
        return ".webp"
    return mimetypes.guess_extension(mime) or ".jpg"

# ---------- Startup ----------
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()

    # ⬇️ asegura la tabla de logs de Drive
    conn = connect()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS drive_backup_logs (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL,
            event_id TEXT,
            filename TEXT,
            status TEXT NOT NULL,             -- 'ok' | 'failed'
            message TEXT,                     -- detalle de error o info
            drive_file_id TEXT,               -- id si se subió OK
            created_at TEXT NOT NULL          -- ISO UTC
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_drive_backup_logs_photo ON drive_backup_logs(photo_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_drive_backup_logs_created ON drive_backup_logs(created_at)")

    # >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    # AUTO‑MIGRACIÓN: asegurar columnas nuevas en photos
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(photos)").fetchall()}

    def add_col(sql: str):
        try:
            conn.execute(sql)
        except Exception:
            # si ya existe o el engine no soporta el ALTER, seguimos
            pass

    if "uploader_name" not in cols:
        add_col("ALTER TABLE photos ADD COLUMN uploader_name TEXT")
    if "uploader_seq" not in cols:
        add_col("ALTER TABLE photos ADD COLUMN uploader_seq INTEGER")
    if "filename" not in cols:
        add_col("ALTER TABLE photos ADD COLUMN filename TEXT")
    # <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

    conn.commit()
    conn.close()

    asyncio.create_task(ticker())
    yield



# ---------- App ----------
app = FastAPI(title="Proyección de fotos", lifespan=lifespan)

# CORS (para Vite)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static: subidas locales + default image
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
# Asegurar default si querés: coloca un default.jpg en backend/static
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Siempre montamos uploads locales (screen sirve desde acá)
LOCAL_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount(BASE_PUBLIC_URL, StaticFiles(directory=LOCAL_UPLOAD_DIR), name="uploads")

# Suscriptores por event_id
SUBSCRIBERS: Dict[str, Set[WebSocket]] = {}

# ---------- Utils ----------
def client_ip(request: Request) -> str:
    # Respeta X-Forwarded-For si hay proxy, si no usa client.host
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

async def broadcast(event_id: str, payload: dict):
    if event_id in SUBSCRIBERS:
        dead = []
        for ws in list(SUBSCRIBERS[event_id]):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            SUBSCRIBERS[event_id].discard(ws)

# -- LOGS --


def log_drive_backup(
    photo_id: str,
    status: str,
    message: str = "",
    drive_file_id: Optional[str] = None,
    event_id: Optional[str] = None,
    filename: Optional[str] = None
):
    conn = connect()
    try:
        conn.execute("""
            INSERT INTO drive_backup_logs (id, photo_id, event_id, filename, status, message, drive_file_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            uuid.uuid4().hex,
            photo_id,
            event_id,
            filename,
            status,
            message[:2000],
            drive_file_id,
            datetime.now(timezone.utc).isoformat()
        ))
        conn.commit()
    finally:
        conn.close()


# ---------- Health ----------
@app.get("/api/health")
def health():
    return {"ok": True}

# ---------- Drive backup worker (async, no bloquea) ----------
GOOGLE_DRIVE_BACKUP_ENABLED = os.getenv("GOOGLE_DRIVE_BACKUP_ENABLED", "true").lower() in ("1","true","yes")
GOOGLE_DRIVE_MAKE_PUBLIC = os.getenv("GOOGLE_DRIVE_MAKE_PUBLIC", "false").lower() in ("1","true","yes")

# cerca de tus otras utils en main.py
def _get_folder_id() -> str:
    raw = os.getenv("GOOGLE_DRIVE_FOLDER_ID") or ""
    return raw.strip().strip('"').strip("'")


async def _backup_to_drive_from_path_async(
    photo_id: str,
    path: Path,
    filename: str,
    mime_type: str,
    event_id: str,
):
    if not GOOGLE_DRIVE_BACKUP_ENABLED:
        log_drive_backup(photo_id, "failed", "Backup disabled by env", event_id=event_id, filename=filename)
        return

    folder_id = _get_folder_id()
    if not folder_id:
        log_drive_backup(photo_id, "failed", "Missing GOOGLE_DRIVE_FOLDER_ID", event_id=event_id, filename=filename)
        return

    try:
        drive = get_drive_client()

        # Si tu cliente tiene soporte nativo de path, úsalo
        if hasattr(drive, "upload_path"):
            uploaded = drive.upload_path(
                path=str(path),
                filename=filename,
                mime_type=mime_type or "application/octet-stream",
                folder_id=folder_id,
                make_public=GOOGLE_DRIVE_MAKE_PUBLIC,
                chunksize_mb=10,  # resumable
            )
        else:
            # Fallback de compatibilidad (carga a memoria, sólo si tu wrapper no soporta path)
            with path.open("rb") as f:
                content = f.read()
            uploaded = drive.upload_bytes(
                content=content,
                filename=filename,
                mime_type=mime_type or "application/octet-stream",
                folder_id=folder_id,
                make_public=GOOGLE_DRIVE_MAKE_PUBLIC,
            )

        log_drive_backup(photo_id, "ok", f"Drive id={uploaded.get('id')}", event_id=event_id, filename=filename)
    except Exception as e:
        log_drive_backup(photo_id, "failed", f"{type(e).__name__}: {e}", event_id=event_id, filename=filename)

# ---------- Upload ----------
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, Request, HTTPException, Header
import re
NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')

@app.post("/api/photos")
async def post_photo(
    request: Request,
    file: UploadFile = File(...),
    event: str = Form(...),
    device_id: Optional[str] = Form(None),
    uploader_name_form: Optional[str] = Form(None),
    x_device_id: Optional[str] = Header(None),
    x_uploader_name: Optional[str] = Header(None),
):
    device = (x_device_id or device_id or client_ip(request)).strip()
    allowed, remain = rate_allow_with_fallback(event, device, RATE_WINDOW)
    if not allowed:
        return JSONResponse(status_code=429, content={"error": f"Rate limit: esperá {remain}s entre subidas","remaining": remain})

    # ---- validar MIME ----
    if file.content_type not in ALLOWED_MIME:
        raise HTTPException(status_code=400, detail="Tipo no permitido")

    # ---- nombre de usuario ----
    uploader = (x_uploader_name or uploader_name_form or "").strip()
    if not NAME_RE.match(uploader):
        raise HTTPException(400, detail="uploader_name inválido")

    # ---- extensión y filename final (Usuario01.jpg) ----
    ext = guess_ext_from_mime(file.content_type)

    # Calcular secuencia atomica por (event, uploader)
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT COALESCE(MAX(uploader_seq),0) AS mx FROM photos WHERE event_id=? AND uploader_name=?",
            (event, uploader)
        ).fetchone()
        next_seq = int(row["mx"] or 0) + 1
        base_name = f"{uploader}{next_seq:02d}{ext}"
        conn.commit()
    finally:
        conn.close()

    # --- Guardar a disco en streaming, controlando MAX_IMAGE_MB ---
    dst_path = LOCAL_UPLOAD_DIR / base_name
    written = await save_upload_streaming_strict(file, dst_path, max_mb=MAX_IMAGE_MB)

    public_url = f"{BASE_PUBLIC_URL}/{base_name}"

    # Insertar en DB (status queued) y lanzar backup
    now_iso = datetime.now(timezone.utc).isoformat()
    photo_id = uuid.uuid4().hex

    conn = connect()
    try:
        conn.execute(
            """INSERT INTO photos(id,event_id,gdrive_file_id,public_url,status,created_at,uploader_name,uploader_seq,filename)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (photo_id, event, None, public_url, "queued", now_iso, uploader, next_seq, base_name)
        )
        conn.commit()
    finally:
        conn.close()

    # Backup a Drive con el MISMO filename (desde PATH, sin RAM)
    asyncio.create_task(_backup_to_drive_from_path_async(
        photo_id=photo_id,
        path=dst_path,
        filename=base_name,
        mime_type=file.content_type or "application/octet-stream",
        event_id=event
    ))

    await broadcast(event, {"type": "queue_update"})
    return {"ok": True, "photo_id": photo_id, "url": public_url, "filename": base_name, "uploader_seq": next_seq, "drive_backup": "scheduled"}



# ---------- Estado de pantalla ----------
@app.get("/api/screen/state", response_model=ScreenStateResponse)
def screen_state(event: str):
    conn = connect()
    ph = conn.execute("SELECT * FROM playhead WHERE event_id=?", (event,)).fetchone()
    queue_count = conn.execute(
        "SELECT COUNT(*) c FROM photos WHERE event_id=? AND status='queued'",
        (event,)
    ).fetchone()["c"]

    if not ph or not ph["current_photo_id"]:
        # default
        conn.close()
        if DEFAULT_IMAGE_URL:
            return {
                "current": {
                    "url": DEFAULT_IMAGE_URL,
                    "duration": IMAGE_DURATION_SECONDS,
                    "started_at": None,
                    "is_default": True
                },
                "queue_size": queue_count,
                "idle": False
            }
        # idle puro → null para activar carrusel en el front
        return {"current": None, "queue_size": queue_count, "idle": True}

    # con reproducción activa
    p = conn.execute(
        "SELECT public_url, uploader_name FROM photos WHERE id=?",
        (ph["current_photo_id"],)
    ).fetchone()
    conn.close()

    if not p:
        # playhead apunta a algo inexistente → tratamos como idle/default
        if DEFAULT_IMAGE_URL:
            return {
                "current": {
                    "url": DEFAULT_IMAGE_URL,
                    "duration": IMAGE_DURATION_SECONDS,
                    "started_at": None,
                    "is_default": True
                },
                "queue_size": queue_count,
                "idle": False
            }
        return {"current": None, "queue_size": queue_count, "idle": True}

    return {
        "current": {
            "url": p["public_url"],
            "duration": ph["duration_seconds"],
            "started_at": ph["started_at"],
            "username": p["uploader_name"],
            "is_default": False
        },
        "queue_size": queue_count,
        "idle": False
    }

# ---------- WebSocket para pantallas ----------
@app.websocket("/api/ws/screen")
async def ws_screen(ws: WebSocket, event: str):
    await ws.accept()
    SUBSCRIBERS.setdefault(event, set()).add(ws)
    try:
        # Loop de keep-alive para que ningún proxy cierre por inactividad
        while True:
            await asyncio.sleep(25)
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        SUBSCRIBERS[event].discard(ws)

# ---------- Scheduler / playhead ----------
async def ticker():
    while True:
        await asyncio.sleep(1)
        await rotate_if_needed()

async def rotate_if_needed():
    # Iterar por events que existan
    conn = connect()
    events = conn.execute("""
        SELECT DISTINCT event_id FROM (
            SELECT event_id FROM playhead
            UNION
            SELECT event_id FROM photos
        )
    """).fetchall()
    conn.close()

    for row in events:
        event_id = row["event_id"]
        conn = connect()
        ph = conn.execute("SELECT * FROM playhead WHERE event_id=?", (event_id,)).fetchone()
        now = datetime.now(timezone.utc)

        if not ph or not ph["current_photo_id"] or not ph["started_at"]:
            nxt = conn.execute(
                "SELECT id FROM photos WHERE event_id=? AND status='queued' ORDER BY created_at LIMIT 1",
                (event_id,)
            ).fetchone()
            if nxt:
                conn.execute("""
                    INSERT INTO playhead(event_id,current_photo_id,started_at,duration_seconds)
                    VALUES(?,?,?,?)
                    ON CONFLICT(event_id) DO UPDATE SET
                      current_photo_id=excluded.current_photo_id,
                      started_at=excluded.started_at,
                      duration_seconds=excluded.duration_seconds
                """, (event_id, nxt["id"], now.isoformat(), IMAGE_DURATION_SECONDS))
                conn.execute("UPDATE photos SET status='shown', shown_at=? WHERE id=?", (now.isoformat(), nxt["id"]))
                conn.commit()
                conn.close()
                await broadcast(event_id, {"type": "current_update"})
                continue
            conn.close()
            continue

        started = datetime.fromisoformat(ph["started_at"])
        dur = ph["duration_seconds"] or IMAGE_DURATION_SECONDS
        if now >= started + timedelta(seconds=dur):
            nxt = conn.execute(
                "SELECT id FROM photos WHERE event_id=? AND status='queued' ORDER BY created_at LIMIT 1",
                (event_id,)
            ).fetchone()
            if nxt:
                conn.execute(
                    "UPDATE playhead SET current_photo_id=?, started_at=?, duration_seconds=? WHERE event_id=?",
                    (nxt["id"], now.isoformat(), IMAGE_DURATION_SECONDS, event_id)
                )
                conn.execute("UPDATE photos SET status='shown', shown_at=? WHERE id=?", (now.isoformat(), nxt["id"]))
                conn.commit()
                conn.close()
                await broadcast(event_id, {"type": "current_update"})
            else:
                conn.execute("UPDATE playhead SET current_photo_id=NULL, started_at=NULL WHERE event_id=?", (event_id,))
                conn.commit()
                conn.close()
                await broadcast(event_id, {"type": "current_update"})
        else:
            conn.close()



# ----- TEST DRIVE ------
@app.post("/api/drive/test")
def drive_test():
    try:
        drive = get_drive_client()
        folder_id = _get_folder_id()
        print("[drive-test] folder_id:", folder_id)
        res = drive.upload_bytes(
            content=b"ping",
            filename=f"drive_test_{int(time.time())}.txt",
            mime_type="text/plain",
            folder_id=folder_id,
            make_public=False
        )
        return {"ok": True, "file_id": res.get("id")}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})



# ----- ULTIMOS LOGS --------
@app.get("/api/drive/logs")
def drive_logs(limit: int = 50, status: Optional[str] = None):
    sql = "SELECT * FROM drive_backup_logs"
    params = []
    if status in ("ok","failed"):
        sql += " WHERE status=?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    conn = connect()
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return {"items": rows}


@app.get("/api/drive/folder-check")
def drive_folder_check():
    try:
        folder_id = _get_folder_id()
        if not folder_id:
            return JSONResponse(status_code=400, content={"ok": False, "error": "GOOGLE_DRIVE_FOLDER_ID vacío"})
        svc = get_drive_client().service
        meta = svc.files().get(
            fileId=folder_id,
            fields="id,name,mimeType,owners(emailAddress)"
        ).execute()
        return {"ok": True, "meta": meta}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


# -----------------------------------------------------------------------------------
def build_defaults_manifest():
    """
    Genera la lista del carrusel en base al .env, sin leer disco.
    Respeta el orden: DEFAULTS_START..DEFAULTS_END.
    """
    items = []
    order = 0
    for n in range(DEFAULTS_START, DEFAULTS_END + 1):
        num = str(n).zfill(DEFAULTS_PAD)
        url = f"{DEFAULTS_DIR}/{DEFAULTS_PREFIX}{num}{DEFAULTS_EXT}"
        items.append(DefaultItem(url=url, order=order, duration_ms=DEFAULTS_MS))
        order += 1
    return items

@app.get("/api/screen/defaults", response_model=DefaultsResponse)
def api_screen_defaults(event: str = "default"):
    # Si mañana querés tener defaults por evento, podés condicionar por `event`
    items = build_defaults_manifest()
    return {"items": items}
