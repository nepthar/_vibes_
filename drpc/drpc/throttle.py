"""A bytes-per-second budget, as a token bucket that's allowed to go into debt.

Everything a connection costs is charged in bytes: lines in, replies out, and
the LLM's tokens (at BYTES_PER_TOKEN each). Charging happens after the fact;
before reading the next line, the connection waits until it's out of debt. So
a client is never refused, only slowed, and TCP backpressure tells it so.
"""

import asyncio
import time

BYTES_PER_TOKEN = 4  # roughly what a token of English is worth on the wire


class Throttle:
    def __init__(self, bytes_per_sec: float, burst: float):
        self.rate = bytes_per_sec
        self.burst = burst
        self.level = burst
        self.stamp = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        self.level = min(self.burst, self.level + (now - self.stamp) * self.rate)
        self.stamp = now

    def charge(self, nbytes: float) -> None:
        self._refill()
        self.level -= nbytes

    async def wait(self) -> None:
        self._refill()
        if self.level < 0:
            await asyncio.sleep(-self.level / self.rate)
            self._refill()
