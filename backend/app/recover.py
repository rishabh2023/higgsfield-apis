"""Rebuild the database from data/ledger.jsonl.

    cd backend && uv run python -m app.recover          # rebuild (current DB is kept aside, not deleted)
    cd backend && uv run python -m app.recover --check  # just report what the ledger contains

Stop the app first. Nothing is regenerated: running jobs resume polling by their saved
Higgsfield request IDs and missing video files are re-downloaded — both free.
"""

import argparse
import collections
import sys

from app import db, ledger
from app.config import get_settings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="only summarize the ledger")
    args = ap.parse_args()

    path = get_settings().database_path
    lp = ledger.path_for(path)
    if not lp.exists():
        print(f"No ledger at {lp}. Nothing to recover from.")
        return 1

    latest: dict[tuple[str, str], dict] = {}
    for rec in ledger.read(lp):
        latest[(rec.get("table"), rec.get("key"))] = rec
    alive = [r for r in latest.values() if r.get("op") == "upsert"]
    by_table = collections.Counter(r["table"] for r in alive)
    statuses = collections.Counter(r["row"].get("status") for r in alive if r["table"] == "generations")
    request_ids = sum(1 for r in alive if r["table"] == "generations" and r["row"].get("hf_request_id"))
    print(f"Ledger: {lp}")
    print(f"  rows: {dict(by_table)}")
    print(f"  generations by status: {dict(statuses)}")
    print(f"  Higgsfield request IDs on record: {request_ids}")
    if args.check:
        return 0

    if path.exists():
        moved = ledger.quarantine(path, "before-recover")
        print(f"Current database moved to {moved.name} (kept, not deleted).")
    counts = ledger.rebuild(path, db._prepare)
    print(f"Rebuilt {path.name}: {counts}")
    print("Start the app; running jobs resume and missing videos re-download automatically.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
