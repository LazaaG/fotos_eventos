# Backend - Proyección de fotos (FastAPI)

## Requisitos
- Python 3.10+
- (Opcional) Google Cloud Service Account si usás STORAGE=drive

## Setup
```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/Mac:
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
# Editá .env según quieras (para local: STORAGE=local)

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
npm run dev -- --host 0.0.0.0 --port 5173