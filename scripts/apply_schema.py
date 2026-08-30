#!/usr/bin/env python3
"""One-time setup: apply supabase/schema.sql to the league's Supabase project.

Reads the database password from .env (PGPASSWORD=...) so it never appears on
the command line. Tries the direct IPv6 host first, then scans Supabase's
regional connection poolers (IPv4).

Usage: python3 scripts/apply_schema.py <project-ref>
"""

import itertools
import re
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


def read_password():
    env = (ROOT / ".env").read_text()
    m = re.search(r'PGPASSWORD\s*=\s*"?([^"\n]+)"?', env)
    if not m:
        sys.exit("No PGPASSWORD found in .env")
    return m.group(1).strip()


def connect(ref, password):
    targets = [(f"db.{ref}.supabase.co", "postgres")]
    regions = ("us-east-1", "us-east-2", "us-west-1", "us-west-2",
               "eu-west-1", "eu-west-2", "eu-central-1",
               "ap-southeast-1", "ap-southeast-2", "sa-east-1", "ca-central-1")
    for pre, reg in itertools.product(("aws-0", "aws-1"), regions):
        targets.append((f"{pre}-{reg}.pooler.supabase.com", f"postgres.{ref}"))

    for host, user in targets:
        try:
            conn = psycopg2.connect(host=host, port=5432, user=user,
                                    password=password, dbname="postgres",
                                    connect_timeout=5)
            print(f"Connected via {host}")
            return conn
        except Exception as e:  # noqa: BLE001
            msg = str(e).splitlines()[0] if str(e) else repr(e)
            if "could not translate" in msg or "Tenant or user not found" in msg:
                continue  # host doesn't exist / wrong region - expected
            print(f"  {host}: {msg[:100]}")
    sys.exit("Could not reach the database on any known endpoint.")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    ref = sys.argv[1]
    conn = connect(ref, read_password())
    conn.autocommit = True
    sql = (ROOT / "supabase" / "schema.sql").read_text()
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute("select count(*) from picks")
        print(f"Schema applied. picks table exists with {cur.fetchone()[0]} rows.")
        cur.execute("""select policyname from pg_policies where tablename = 'picks'""")
        print("Policies:", ", ".join(r[0] for r in cur.fetchall()))
    conn.close()


if __name__ == "__main__":
    main()
