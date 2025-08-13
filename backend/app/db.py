import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "app.db"

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = connect()
    conn.executescript("""
    PRAGMA journal_mode = wal;
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      gdrive_file_id TEXT,
      public_url TEXT NOT NULL,
      status TEXT CHECK(status IN ('queued','shown')) NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      shown_at TEXT
    );
    CREATE TABLE IF NOT EXISTS playhead (
      event_id TEXT PRIMARY KEY,
      current_photo_id TEXT,
      started_at TEXT,
      duration_seconds INTEGER DEFAULT 30
    );
    """)
    conn.commit()
    conn.close()
