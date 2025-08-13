import time
from typing import Dict, Tuple

class RateLimiter:
    """
    Rate limit simple en memoria: X acciones por ventana de Y segundos por IP y acción.
    """
    def __init__(self, max_actions: int, window_seconds: int):
        self.max_actions = max_actions
        self.window = window_seconds
        # key: (ip, action) -> (window_start_ts, count)
        self.buckets: Dict[Tuple[str, str], Tuple[float, int]] = {}

    def allow(self, ip: str, action: str) -> bool:
        now = time.time()
        key = (ip, action)
        window_start, count = self.buckets.get(key, (now, 0))
        if now - window_start > self.window:
            # nueva ventana
            self.buckets[key] = (now, 1)
            return True
        else:
            if count < self.max_actions:
                self.buckets[key] = (window_start, count + 1)
                return True
            return False

    def remaining(self, ip: str, action: str) -> int:
        now = time.time()
        key = (ip, action)
        window_start, count = self.buckets.get(key, (now, 0))
        if now - window_start > self.window:
            return self.max_actions
        return max(self.max_actions - count, 0)
