import io
import os
from typing import Optional, Dict

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from googleapiclient.errors import HttpError

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from pathlib import Path

# Scopes:
# - "drive.file": crear/gestionar archivos creados por la app (suficiente para la mayoría)
# - "drive": full access (útil si luego cambias permisos)
SCOPES = ["https://www.googleapis.com/auth/drive.file"]

from pathlib import Path

def _resolve_path(path_str: str, default_filename: str) -> Path:
    p = Path(path_str)
    if not p.is_absolute():
        # raíz del proyecto: 2 niveles arriba de este archivo
        proj_root = Path(__file__).resolve().parents[2]
        p = proj_root / path_str
    return p

def _build_service_with_oauth():
    secrets_env = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRETS", "backend/secrets/credentials.json")
    token_env = os.environ.get("GOOGLE_OAUTH_TOKEN_PATH", "backend/secrets/token.json")
    secrets_path = _resolve_path(secrets_env, "credentials.json")
    token_path = _resolve_path(token_env, "token.json")

    if not secrets_path.exists():
        raise RuntimeError(f"No encuentro GOOGLE_OAUTH_CLIENT_SECRETS en: {secrets_path}")

    print("[drive] GOOGLE_OAUTH_CLIENT_SECRETS =", os.environ.get("GOOGLE_OAUTH_CLIENT_SECRETS"))
    print("[drive] GOOGLE_OAUTH_TOKEN_PATH     =", os.environ.get("GOOGLE_OAUTH_TOKEN_PATH"))


    creds: Optional[Credentials] = None
    if not secrets_path:
        raise RuntimeError("Falta GOOGLE_OAUTH_CLIENT_SECRETS")

    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(secrets_path, SCOPES)
            creds = flow.run_local_server(port=0)  # abre navegador la 1ª vez
        with open(token_path, "w") as f:
            f.write(creds.to_json())

    return build("drive", "v3", credentials=creds, cache_discovery=False)

def _build_service_with_service_account() -> any:
    sa_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not sa_path:
        raise RuntimeError("Falta GOOGLE_SERVICE_ACCOUNT_JSON")
    creds = service_account.Credentials.from_service_account_file(sa_path, scopes=["https://www.googleapis.com/auth/drive"])
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def _build_service():
    mode = os.environ.get("DRIVE_AUTH_MODE", "oauth").lower()
    print(f"[drive] auth mode: {mode}")
    if mode == "service_account":
        return _build_service_with_service_account()
    return _build_service_with_oauth()

class DriveClient:
    def __init__(self):
        self.service = _build_service()

    def upload_bytes(
        self,
        content: bytes,
        filename: str,
        mime_type: str,
        folder_id: Optional[str] = None,
        make_public: bool = False,
        is_shared_drive: bool = False,   # úsalos si algún día vas a Shared Drive
    ) -> Dict[str, str]:
        file_metadata = {"name": filename}
        if folder_id:
            file_metadata["parents"] = [folder_id]

        media = MediaIoBaseUpload(io.BytesIO(content), mimetype=mime_type, resumable=True)

        params = {
            "body": file_metadata,
            "media_body": media,
            "fields": "id, name, webViewLink, webContentLink, mimeType",
        }
        if is_shared_drive:
            # Obligatorio para Shared Drives
            params["supportsAllDrives"] = True

        try:
            created = self.service.files().create(**params).execute()

            file_id = created["id"]

            if make_public:
                perm_body = {"type": "anyone", "role": "reader"}
                self.service.permissions().create(
                    fileId=file_id, body=perm_body,
                    supportsAllDrives=is_shared_drive
                ).execute()
                created = self.service.files().get(
                    fileId=file_id,
                    fields="id, name, webViewLink, webContentLink, mimeType",
                    supportsAllDrives=is_shared_drive
                ).execute()

            return {
                "id": created["id"],
                "name": created["name"],
                "mimeType": created["mimeType"],
                "webViewLink": created.get("webViewLink"),
                "webContentLink": created.get("webContentLink"),
            }

        except HttpError as e:
            raise RuntimeError(f"Drive upload failed: {e}")

# Singleton
_drive_client: Optional[DriveClient] = None
def get_drive_client() -> DriveClient:
    global _drive_client
    if _drive_client is None:
        _drive_client = DriveClient()
    return _drive_client
