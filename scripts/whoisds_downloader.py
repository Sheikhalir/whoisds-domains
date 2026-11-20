#!/usr/bin/env python3
"""
WhoisDS Newly Registered Domains - daily downloader
====================================================

Downloads the free daily "newly registered domains" files from
https://www.whoisds.com/newly-registered-domains

The free tier only keeps the last 4 days online, so this script checks
every day that is currently available and downloads any you don't have
yet. If your computer was off for a day or two, the next run catches up
automatically (as long as it runs within ~4 days).

For each day you get:
    <output>/zip/2026-11-18.zip          the original file from WhoisDS
    <output>/txt/2026-11-18.txt          the extracted domain list

Uses only the Python standard library (Python 3.7+). No pip installs.

Usage:
    python whoisds_downloader.py                    # save next to this script
    python whoisds_downloader.py -o "D:\\Domains"    # choose a folder
    python whoisds_downloader.py --no-extract       # keep only the .zip
"""

import argparse
import base64
import datetime as dt
import io
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

PAGE_URL = "https://www.whoisds.com/newly-registered-domains"
DOWNLOAD_URL = "https://www.whoisds.com//whois-database/newly-registered-domains/{token}/nrd"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
LINK_RE = re.compile(r"/newly-registered-domains/([A-Za-z0-9+/=]+)/nrd")
DAYS_TO_CHECK = 6  # a little more than the 4 the site keeps, to be safe

log = logging.getLogger("whoisds")


def token_for(date):
    """WhoisDS links are base64("YYYY-MM-DD.zip")."""
    return base64.b64encode(f"{date.isoformat()}.zip".encode()).decode()


def date_from_token(token):
    try:
        name = base64.b64decode(token).decode()
        return dt.date.fromisoformat(name.replace(".zip", ""))
    except Exception:
        return None


def http_get(url, timeout=120, retries=3):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                raise  # not available - no point retrying
            last_err = e
        except Exception as e:  # network hiccup, timeout, etc.
            last_err = e
        if attempt < retries:
            time.sleep(5 * attempt)
    raise last_err


def available_dates():
    """Dates listed on the website, plus recent dates as a fallback."""
    dates = set()
    try:
        html = http_get(PAGE_URL, timeout=60).decode("utf-8", "replace")
        for token in LINK_RE.findall(html):
            d = date_from_token(token)
            if d:
                dates.add(d)
        log.info("Website lists: %s", ", ".join(str(d) for d in sorted(dates)) or "nothing")
    except Exception as e:
        log.warning("Could not read the listing page (%s); trying recent dates directly.", e)

    today = dt.date.today()
    for i in range(DAYS_TO_CHECK):
        dates.add(today - dt.timedelta(days=i))
    return sorted(dates, reverse=True)


def download_day(date, zip_dir, txt_dir, extract):
    zip_path = os.path.join(zip_dir, f"{date}.zip")
    txt_path = os.path.join(txt_dir, f"{date}.txt")

    if os.path.exists(zip_path) and (not extract or os.path.exists(txt_path)):
        log.info("%s  already downloaded - skipping", date)
        return "skipped"

    url = DOWNLOAD_URL.format(token=token_for(date))
    try:
        data = http_get(url)
    except urllib.error.HTTPError as e:
        log.info("%s  not available (HTTP %s)", date, e.code)
        return "unavailable"
    except Exception as e:
        log.error("%s  download failed: %s", date, e)
        return "failed"

    if not data.startswith(b"PK"):
        # The site returns an HTML page instead of a zip for dates it doesn't have.
        log.info("%s  not available yet", date)
        return "unavailable"

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        if zf.testzip() is not None:
            raise zipfile.BadZipFile("corrupt member")
    except zipfile.BadZipFile as e:
        log.error("%s  downloaded file is not a valid zip (%s)", date, e)
        return "failed"

    tmp = zip_path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, zip_path)

    count = None
    if extract:
        members = [n for n in zf.namelist() if not n.endswith("/")]
        content = b"".join(zf.read(n) for n in members)
        tmp = txt_path + ".part"
        with open(tmp, "wb") as f:
            f.write(content)
        os.replace(tmp, txt_path)
        count = sum(1 for line in content.splitlines() if line.strip())

    msg = f"{date}  downloaded ({len(data) / 1024:.0f} KB"
    msg += f", {count:,} domains)" if count is not None else ")"
    log.info(msg)
    return "downloaded"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description="Download WhoisDS newly registered domain lists.")
    p.add_argument("-o", "--output", default=os.path.join(here, "whoisds_files"),
                   help="folder to save files in (default: whoisds_files next to this script)")
    p.add_argument("--no-extract", action="store_true",
                   help="keep only the .zip files, don't extract the .txt lists")
    args = p.parse_args()

    out = os.path.abspath(args.output)
    zip_dir = os.path.join(out, "zip")
    txt_dir = os.path.join(out, "txt")
    os.makedirs(zip_dir, exist_ok=True)
    if not args.no_extract:
        os.makedirs(txt_dir, exist_ok=True)

    handlers = [logging.FileHandler(os.path.join(out, "download_log.txt"), encoding="utf-8")]
    if sys.stdout is not None:  # pythonw has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s  %(levelname)-7s %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")

    log.info("=== Run started - saving to %s ===", out)
    results = [download_day(d, zip_dir, txt_dir, not args.no_extract) for d in available_dates()]
    log.info("=== Done: %d new, %d already had, %d failed ===",
             results.count("downloaded"), results.count("skipped"), results.count("failed"))
    return 1 if "failed" in results else 0


if __name__ == "__main__":
    sys.exit(main())
