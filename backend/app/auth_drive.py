# backend/app/auth_drive.py
import os
from urllib.parse import urlparse, parse_qs
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

SECRETS = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRETS", "./backend/secrets/credentials.json")
TOKEN   = os.environ.get("GOOGLE_OAUTH_TOKEN_PATH", "./backend/secrets/token.json")

def main():
    creds = None
    if os.path.exists(TOKEN):
        creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(SECRETS, SCOPES)
            # 1) Intento local_server (abre navegador). Si falla, paso a manual.
            try:
                creds = flow.run_local_server(port=0)
            except Exception:
                auth_url, _ = flow.authorization_url(prompt="consent", include_granted_scopes="true")
                print("\nAbrí esta URL en tu navegador, autoriza y copia el CÓDIGO que te da Google:\n")
                print(auth_url, "\n")
                code = input("Pegá aquí el CÓDIGO y presiona Enter: ").strip()
                # Acepta tanto el código pelado como la URL de redirección completa
                if code.startswith("http"):
                    q = parse_qs(urlparse(code).query)
                    code = (q.get("code") or [""])[0]
                flow.fetch_token(code=code)
                creds = flow.credentials

        with open(TOKEN, "w") as f:
            f.write(creds.to_json())

    print("✅ Token guardado en:", os.path.abspath(TOKEN))

if __name__ == "__main__":
    main()
