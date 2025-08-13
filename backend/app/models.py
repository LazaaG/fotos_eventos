from pydantic import BaseModel
from typing import Optional

class ScreenState(BaseModel):
    url: str
    duration: int
    started_at: Optional[str] = None

class ScreenStateResponse(BaseModel):
    current: ScreenState
    queue_size: int
