import os
import io
import uuid
from pathlib import Path
from typing import Tuple
from fastapi import HTTPException

# --- Google Drive ---
from googleapiclient.discovery import build
from google.oauth2 import service_account
from googleapiclient.http import MediaIoBaseUpload

def get_drive_client(sa_path: str):
    creds = service_account.Credentials.from_service_account_file(
        sa_path,
        scopes=["https://www.googleapis.com/auth/drive"]
    )
    return build("drive", "v3", credentials=creds)

def upload_to_drive(file_bytes: bytes, filename: str, mime: str, folder_id: str, sa_path: str) -> Tuple[str, str]:
    try:
        service = get_drive_client(sa_path)
        media = MediaIoBaseUpload(io.BytesIO(file_bytes), mimetype=mime, resumable=False)
        meta = {"name": filename, "parents": [folder_id]}
        uploaded = service.files().create(body=meta, media_body=media, fields="id").execute()
        file_id = uploaded["id"]
        # Hacer público (lectura con enlace)
        service.permissions().create(fileId=file_id, body={"role": "reader", "type": "anyone"}).execute()
        public_url = f"https://drive.google.com/uc?id={file_id}"
        return file_id, public_url
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error subiendo a Drive: {e}")

# --- Local storage ---
def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)

def upload_to_local(file_bytes: bytes, filename: str, upload_dir: Path, base_public_url: str) -> Tuple[str, str]:
    ensure_dir(upload_dir)
    file_id = uuid.uuid4().hex
    out_name = f"{file_id}_{filename}"
    out_path = upload_dir / out_name
    out_path.write_bytes(file_bytes)
    # URL pública servida por FastAPI StaticFiles
    public_url = f"{base_public_url}/{out_name}"
    return file_id, public_url
