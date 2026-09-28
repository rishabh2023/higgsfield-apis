"""In-process background worker that polls accepted Higgsfield requests to completion.

State lives in SQLite (next_poll_at / poll_delay), so a restart resumes polling.
"""

import asyncio
import logging

import time

from app import db, media, service

log = logging.getLogger("app.poller")


class Poller:
    def __init__(self, tick_seconds: float = 1.0, concurrency: int = 8) -> None:
        self._tick = tick_seconds
        self._sem = asyncio.Semaphore(concurrency)
        self._inflight: set[str] = set()
        self._task: asyncio.Task | None = None
        self._next_backup = 0.0

    def start(self) -> None:
        recovered = service.recover_orphaned_submissions()
        if recovered:
            log.warning("marked %d orphaned submissions as submission_unknown", recovered)
        media.bind_loop(asyncio.get_running_loop())
        media.resume_downloads()
        self._task = asyncio.create_task(self._run(), name="higgsfield-poller")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while True:
            try:
                for gid in service.due_for_poll():
                    if gid not in self._inflight:
                        self._inflight.add(gid)
                        asyncio.create_task(self._poll(gid))
            except Exception:  # keep the worker alive
                log.exception("poller tick failed")
            if time.time() >= self._next_backup:
                self._next_backup = time.time() + 3600
                try:
                    made = await asyncio.to_thread(db.backup_now)
                    if made:
                        log.info("daily database backup: %s", made.name)
                except Exception:
                    log.exception("database backup failed")
            await asyncio.sleep(self._tick)

    async def _poll(self, gid: str) -> None:
        try:
            async with self._sem:
                await service.poll_one(gid)
        except Exception:
            log.exception("polling %s crashed", gid)
        finally:
            self._inflight.discard(gid)
