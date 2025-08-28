from pydantic import BaseModel
from typing import Optional, List

class ScreenState(BaseModel):
    url: str
    duration: int
    started_at: Optional[str] = None
    username: Optional[str] = None
    is_default: Optional[bool] = None

class ScreenStateResponse(BaseModel):
    current: Optional[ScreenState] = None
    queue_size: int
    idle: bool = False

# === Carrusel ===
class DefaultItem(BaseModel):
    url: str
    order: int
    duration_ms: int

class DefaultsResponse(BaseModel):
    items: List[DefaultItem]