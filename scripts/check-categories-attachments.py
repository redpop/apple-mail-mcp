#!/usr/bin/python3 -I
# Pruefskript fuer AMM-13: (1) Was steht in message_global_data.model_category, und welcher Wert
# gehoert zu welcher Kategorie in Mail? (2) Wo liegen Anhaenge auf der Platte, und wie gross sind
# sie? Martin startet es selbst aus einem Terminal mit Full Disk Access:
#   /usr/bin/python3 -I scripts/check-categories-attachments.py
#
# Abgleich mit der Mail-Oberflaeche: Abschnitt 4 nennt je Konto (A1, A2, ...) und Wert die
# ungelesenen Mails im Eingang. Mail zeigt dieselben Zahlen an den Kategorie-Knoepfen. Abschnitt 6
# nennt SelectedBucket je Eingang: In Mail eine Kategorie waehlen, Mail beenden, Skript erneut
# starten; der Wert zeigt die Nummer der gewaehlten Kategorie.
#
# Datenschutz: Die Ausgabe enthaelt nur Zaehler, Prozente, Jahr-Monat-Angaben, Ja/Nein-Werte,
# Spaltennamen und Dateiendungen aus einer festen Liste. Keine Betreffs, Absender, Adressen,
# Dateinamen, Mailboxnamen oder UUIDs (Konten heissen A1, A2, ... in der Reihenfolge ihrer
# kleinsten Mailbox-ROWID). Jede Zeile laeuft durch out(); dort werden $HOME, Adressen und UUIDs
# geschwaerzt. Alles ist lesend (SQLite per URI mode=ro, nie immutable). Es wird nichts
# geschrieben, auch kein Bericht.
#
# Optionen:
#   --sample N   Anzahl der neuesten Mails mit Anhang, deren Dateien geprueft werden (Standard 2000)
#   --root DIR   NUR FUER SELBSTTESTS mit synthetischen Daten. Standard: ~/Library/Mail
import argparse
import collections
import datetime
import os
import platform
import plistlib
import re
import sqlite3
import sys
import urllib.parse

HOME = os.path.expanduser("~")
UUID_PAT = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
UUID_RE = re.compile("^" + UUID_PAT + "$")
UUID_ANY = re.compile(UUID_PAT)
EMAIL_RE = re.compile(r"[^\s@<>\"']+@[^\s@<>\"']+")
PART_RE = re.compile(r"^\d+(\.\d+)*$")
MAX_PLIST = 5 * 1024 * 1024
MIB = 1024 * 1024

# Nur diese Endungen werden genannt, alles andere heisst "other".
EXTENSIONS = {
    "pdf": "pdf",
    "docx": "ooxml", "xlsx": "ooxml", "pptx": "ooxml", "docm": "ooxml", "xlsm": "ooxml",
    "doc": "legacy-office", "xls": "legacy-office", "ppt": "legacy-office",
    "odt": "odf", "ods": "odf", "odp": "odf",
    "pages": "iwork", "numbers": "iwork", "key": "iwork",
    "rtf": "text", "txt": "text", "csv": "text", "ics": "text", "vcf": "text", "md": "text",
    "html": "text", "htm": "text", "xml": "text", "json": "text",
    "png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "heic": "image",
    "tif": "image", "tiff": "image", "webp": "image", "svg": "image",
    "zip": "archive", "gz": "archive", "7z": "archive", "rar": "archive",
    "eml": "mail", "msg": "mail", "p7s": "signature", "p7m": "signature", "asc": "signature",
    "pkpass": "other-known", "mp3": "media", "m4a": "media", "mp4": "media", "mov": "media",
}
SIZE_BUCKETS = [(256 * 1024, "<256K"), (MIB, "256K-1M"), (8 * MIB, "1-8M"), (20 * MIB, "8-20M")]


def out(text=""):
    """Einzige Ausgabestelle: $HOME -> ~, Adressen und UUIDs als Notbremse schwaerzen."""
    for line in str(text).split("\n"):
        line = line.replace(HOME, "~")
        line = EMAIL_RE.sub("<redacted>", line)
        line = UUID_ANY.sub("<uuid>", line)
        print(line, flush=True)


def header(n, title):
    out()
    out("== %d. %s" % (n, title))


def pct(a, b):
    return "n/a" if not b else "%.1f%%" % (100.0 * a / b)


def val(v):
    """Kategoriewert fuer die Ausgabe: nur ganze Zahlen, sonst Typname."""
    if v is None:
        return "NULL"
    return str(v) if isinstance(v, int) else "<%s>" % type(v).__name__


def month(ts):
    if not isinstance(ts, (int, float)) or ts <= 0:
        return "-"
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m")


def size_bucket(n):
    for limit, name in SIZE_BUCKETS:
        if n < limit:
            return name
    return ">=20M"


def ext_of(name):
    if not isinstance(name, str) or "." not in name:
        return "(none)"
    e = name.rsplit(".", 1)[1].lower()
    return e if e in EXTENSIONS else "other"


def open_ro(path):
    uri = "file:" + urllib.parse.quote(path) + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def find_version_dir(root):
    best = None
    for n in os.listdir(root):
        m = re.fullmatch(r"V(\d+)", n)
        if m and os.path.isdir(os.path.join(root, n)):
            if best is None or int(m.group(1)) > best[0]:
                best = (int(m.group(1)), os.path.join(root, n))
    return best


def columns(con, table):
    return {r[1] for r in con.execute("PRAGMA table_info(%s)" % table)}


def tables(con):
    return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def counter_line(c, total=None, order=None):
    keys = order if order is not None else sorted(c, key=lambda k: (k == "NULL", str(k)))
    parts = []
    for k in keys:
        n = c.get(k, 0)
        parts.append("%s=%d%s" % (k, n, "" if total is None else " (%s)" % pct(n, total)))
    return ", ".join(parts) if parts else "-"


# --------------------------------------------------------------------------- Konten und Mailboxen

class Mailbox:
    def __init__(self, rowid, url):
        p = urllib.parse.urlsplit(url or "")
        self.rowid = rowid
        self.url = url or ""
        self.scheme = p.scheme.lower()
        self.account = p.netloc
        segs = [urllib.parse.unquote(s) for s in p.path.split("/") if s]
        self.segments = segs
        self.is_inbox = bool(segs) and segs[-1].upper() == "INBOX" and len(segs) == 1
        self.label = "?"


def load_mailboxes(con):
    boxes = {}
    first = {}
    for rid, url in con.execute("SELECT ROWID, url FROM mailboxes ORDER BY ROWID"):
        b = Mailbox(rid, url)
        boxes[rid] = b
        if b.account and b.account not in first:
            first[b.account] = rid
    labels = {acc: "A%d" % i for i, acc in enumerate(sorted(first, key=first.get), 1)}
    for b in boxes.values():
        b.label = labels.get(b.account, "?")
    return boxes, labels


# --------------------------------------------------------------------------- Ablage (wie EmlxLocator)

def mbox_path(vdir, b):
    if b.scheme not in ("imap", "local") or not b.account or not b.segments:
        return None
    for s in [b.account] + b.segments:
        if s in (".", "..") or "/" in s or "\0" in s:
            return None
    return os.path.join(vdir, b.account, *[s + ".mbox" for s in b.segments])


def digit_dirs(rowid):
    q = rowid // 1000
    return [] if q == 0 else list(str(q)[::-1])


_store_cache = {}


def stores(mbox):
    if mbox not in _store_cache:
        try:
            names = sorted(os.listdir(mbox))
        except OSError:
            names = []
        _store_cache[mbox] = [n for n in names if UUID_RE.match(n) and os.path.isdir(os.path.join(mbox, n, "Data"))]
    return _store_cache[mbox]


def locate(vdir, b, rowid):
    """-> (state, data_dir, data_root) mit state full/partial/none; data_dir = <data_root>/<ziffern>."""
    mbox = mbox_path(vdir, b)
    if mbox is None:
        return "none", None, None
    for suffix, state in ((".emlx", "full"), (".partial.emlx", "partial")):
        for st in stores(mbox):
            root = os.path.join(mbox, st, "Data")
            d = os.path.join(root, *digit_dirs(rowid))
            if os.path.isfile(os.path.join(d, "Messages", "%d%s" % (rowid, suffix))):
                return state, d, root
    return "none", None, None


# --------------------------------------------------------------------------- 1-6 Kategorien

def run_categories(con, boxes, labels, vdir):
    tabs = tables(con)
    mgd = columns(con, "message_global_data") if "message_global_data" in tabs else set()
    ba = columns(con, "business_addresses") if "business_addresses" in tabs else set()
    bc = columns(con, "business_categories") if "business_categories" in tabs else set()

    header(1, "Schema")
    for col in ("model_category", "model_subcategory", "category_model_version", "category_is_temporary",
                "model_high_impact", "urgent"):
        out("message_global_data.%s: %s" % (col, "yes" if col in mgd else "no"))
    out("business_addresses.category: %s" % ("yes" if "category" in ba else "no"))
    out("business_categories.category: %s" % ("yes" if "category" in bc else "no"))
    if "model_category" not in mgd:
        out("model_category missing: category checks skipped")
        return

    # Je globale Mail: Kategorie und Datum der neuesten nicht geloeschten Kopie.
    rows = con.execute("""
        SELECT g.ROWID, g.model_category, max(m.date_received), max(m.read = 0)
        FROM message_global_data g JOIN messages m ON m.global_message_id = g.ROWID AND m.deleted = 0
        GROUP BY g.ROWID""").fetchall()

    header(2, "Distribution of model_category (distinct mails with a non-deleted copy)")
    total = len(rows)
    dist = collections.Counter(val(r[1]) for r in rows)
    out("mails: %d" % total)
    out("values: %s" % counter_line(dist, total))
    raw_all = collections.Counter(val(r[0]) for r in con.execute("SELECT model_category FROM message_global_data"))
    out("all message_global_data rows, incl. without copy: %s" % counter_line(raw_all))

    header(3, "Time range (date_received of the newest copy, UTC year-month)")
    span = {}
    for _, cat, d, _ in rows:
        k = val(cat)
        lo, hi = span.get(k, (None, None))
        if isinstance(d, int):
            lo = d if lo is None else min(lo, d)
            hi = d if hi is None else max(hi, d)
        span[k] = (lo, hi)
    for k in sorted(span, key=lambda k: (k == "NULL", k)):
        out("%-6s first %s, last %s" % (k, month(span[k][0]), month(span[k][1])))
    with_cat = [r for r in rows if r[1] is not None]
    if with_cat:
        first = min((r[2] for r in with_cat if isinstance(r[2], int)), default=None)
        if first is not None:
            newer = [r for r in rows if isinstance(r[2], int) and r[2] >= first]
            out("since the first categorised mail (%s): %d mails, %s with a value" % (
                month(first), len(newer), pct(sum(1 for r in newer if r[1] is not None), len(newer))))
    now = max((r[2] for r in rows if isinstance(r[2], int)), default=0)
    for days in (7, 30, 90, 365):
        recent = [r for r in rows if isinstance(r[2], int) and r[2] >= now - days * 86400]
        out("last %3d days before the newest mail: %d mails, values %s" % (
            days, len(recent), counter_line(collections.Counter(val(r[1]) for r in recent), len(recent))))
    years = collections.defaultdict(collections.Counter)
    for _, cat, d, _ in rows:
        years[month(d)[:4]][val(cat)] += 1
    for y in sorted(years):
        out("year %s: %s" % (y, counter_line(years[y])))

    header(4, "Inbox per account: compare with the category buttons in Mail")
    out("Per account inbox (non-deleted rows; 'unread' = read = 0). Mail shows unread counts on the buttons.")
    out("'eff1' = sender override from business_addresses.category, else model_category.")
    out("'eff2' = business_addresses.category, else business_categories.category, else model_category.")
    override = "category" in ba
    bizcat = "category" in bc
    q = """
        SELECT m.mailbox, g.model_category, m.read,
               %s AS addr_cat, %s AS biz_cat
        FROM messages m
        LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id
        %s %s
        WHERE m.deleted = 0""" % (
        "ba.category" if override else "NULL",
        "bc.category" if (override and bizcat) else "NULL",
        "LEFT JOIN business_addresses ba ON ba.address = m.sender" if override else "",
        "LEFT JOIN business_categories bc ON bc.business = ba.business" if (override and bizcat) else "")
    inbox_ids = {rid for rid, b in boxes.items() if b.is_inbox}
    per = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    cross = collections.Counter()
    for mb, cat, read, acat, bcat in con.execute(q):
        if mb not in inbox_ids:
            continue
        lab = boxes[mb].label
        e1 = acat if acat is not None else cat
        e2 = acat if acat is not None else (bcat if bcat is not None else cat)
        for kind, v in (("model", cat), ("eff1", e1), ("eff2", e2)):
            per[lab][kind + " all"][val(v)] += 1
            if read == 0:
                per[lab][kind + " unread"][val(v)] += 1
        cross[(val(cat), val(acat), val(bcat))] += 1
    if not per:
        out("no inbox found (mailbox URL with a single segment INBOX)")
    for lab in sorted(per, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0):
        out("%s:" % lab)
        for kind in ("model", "eff1", "eff2"):
            for sub in ("unread", "all"):
                out("  %-12s %s" % (kind + " " + sub, counter_line(per[lab][kind + " " + sub])))
    out("all inboxes, model_category x business_addresses.category x business_categories.category:")
    for (a, b, c), n in sorted(cross.items(), key=lambda kv: -kv[1]):
        out("  model=%s addr=%s biz=%s: %d" % (a, b, c, n))

    header(5, "Related columns per model_category (distinct mails)")
    extra = [c for c in ("model_subcategory", "category_model_version", "category_is_temporary",
                         "model_high_impact", "urgent") if c in mgd]
    for col in extra:
        c = collections.defaultdict(collections.Counter)
        for cat, v in con.execute("SELECT model_category, %s FROM message_global_data" % col):
            c[val(cat)][val(v)] += 1
        out("%s:" % col)
        for k in sorted(c, key=lambda k: (k == "NULL", k)):
            out("  model_category=%s: %s" % (k, counter_line(c[k])))
    if override:
        out("business_addresses.category overall: %s" % counter_line(collections.Counter(
            val(r[0]) for r in con.execute("SELECT category FROM business_addresses"))))
    if bizcat:
        out("business_categories.category overall: %s" % counter_line(collections.Counter(
            val(r[0]) for r in con.execute("SELECT category FROM business_categories"))))

    header(6, "Mailbox Info.plist: CategoriesEnabled and SelectedBucket")
    enabled = collections.Counter()
    bucket = collections.Counter()
    inbox_lines = []
    for acc, lab in sorted(labels.items(), key=lambda kv: int(kv[1][1:])):
        top = os.path.join(vdir, acc)
        if not os.path.isdir(top):
            continue
        for dp, dns, fns in os.walk(top):
            dns[:] = [d for d in dns if d.endswith(".mbox")]
            if not dp.endswith(".mbox") or "Info.plist" not in fns:
                continue
            p = os.path.join(dp, "Info.plist")
            try:
                if os.path.getsize(p) > MAX_PLIST:
                    continue
                with open(p, "rb") as f:
                    d = plistlib.load(f)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            ce = d.get("CategoriesEnabled")
            sb = d.get("SelectedBucket")
            enabled["absent" if ce is None else val(ce if not isinstance(ce, bool) else int(ce))] += 1
            if sb is not None:
                bucket[val(sb if not isinstance(sb, bool) else int(sb))] += 1
            if os.path.relpath(dp, top).upper() == "INBOX.MBOX":
                inbox_lines.append("%s inbox: CategoriesEnabled=%s SelectedBucket=%s" % (
                    lab, "absent" if ce is None else val(int(ce) if isinstance(ce, bool) else ce),
                    "absent" if sb is None else val(int(sb) if isinstance(sb, bool) else sb)))
    out("Info.plist files, CategoriesEnabled: %s" % counter_line(enabled))
    out("SelectedBucket values: %s" % counter_line(bucket))
    for line in inbox_lines:
        out(line)


# --------------------------------------------------------------------------- 7-9 Anhaenge

def run_attachments(con, boxes, vdir, sample):
    header(7, "Attachments in the database")
    acols = columns(con, "attachments")
    rows = con.execute("""
        SELECT a.message, a.attachment_id, a.name FROM attachments a
        JOIN messages m ON m.ROWID = a.message AND m.deleted = 0""").fetchall()
    msgs = {r[0] for r in rows}
    out("attachment rows (non-deleted messages): %d on %d message rows" % (len(rows), len(msgs)))
    out("attachment_id column: %s" % ("yes" if "attachment_id" in acols else "no"))
    ids = collections.Counter("part-number" if isinstance(r[1], str) and PART_RE.match(r[1]) else
                              ("NULL" if r[1] is None else "other") for r in rows)
    out("attachment_id format: %s" % counter_line(ids))
    ext = collections.Counter(ext_of(r[2]) for r in rows)
    out("extensions: %s" % counter_line(ext, len(rows), sorted(ext, key=lambda k: -ext[k])))
    cls = collections.Counter(EXTENSIONS.get(ext_of(r[2]), ext_of(r[2])) for r in rows)
    out("classes: %s" % counter_line(cls, len(rows), sorted(cls, key=lambda k: -cls[k])))
    per_msg = collections.Counter(collections.Counter(r[0] for r in rows).values())
    out("attachments per message: %s" % ", ".join("%d:%d" % kv for kv in sorted(per_msg.items())[:12]))

    header(8, "Files for the %d newest message rows with an attachment" % sample)
    by_msg = collections.defaultdict(list)
    for mid, aid, name in rows:
        by_msg[mid].append((aid, name))
    newest = con.execute("""
        SELECT m.ROWID, m.mailbox FROM messages m
        WHERE m.deleted = 0 AND EXISTS (SELECT 1 FROM attachments a WHERE a.message = m.ROWID)
        ORDER BY m.date_received DESC, m.ROWID DESC LIMIT ?""", (sample,)).fetchall()
    state = collections.Counter()
    emlx_size = collections.defaultdict(collections.Counter)
    att = collections.Counter()
    att_size = collections.defaultdict(collections.Counter)
    for rowid, mb in newest:
        b = boxes.get(mb)
        if b is None:
            state["no mailbox"] += 1
            continue
        st, d, root = locate(vdir, b, rowid)
        state[st] += 1
        if d is None:
            continue
        emlx = os.path.join(d, "Messages", "%d%s" % (rowid, ".emlx" if st == "full" else ".partial.emlx"))
        try:
            emlx_size[st][size_bucket(os.stat(emlx).st_size)] += 1
        except OSError:
            pass
        try:
            parts_files = [f for f in os.listdir(os.path.join(d, "Messages")) if f.startswith("%d." % rowid) and f.endswith(".emlxpart")]
        except OSError:
            parts_files = []
        if parts_files:
            att["%s: has .emlxpart files" % st] += 1
        adir = os.path.join(d, "Attachments", str(rowid))
        flat = os.path.join(root, "Attachments", str(rowid))
        if not os.path.isdir(adir):
            att["%s: no Attachments/<ROWID> dir" % st] += 1
            if flat != adir and os.path.isdir(flat):
                att["%s: Data/Attachments/<ROWID> without digit dirs" % st] += 1
            continue
        att["%s: Attachments/<ROWID> dir" % st] += 1
        try:
            subs = os.listdir(adir)
        except OSError:
            att["%s: dir not listable" % st] += 1
            continue
        db_ids = {a for a, _ in by_msg.get(rowid, []) if isinstance(a, str)}
        names = set(subs)
        att["%s: part dirs == db attachment_ids" % st if names == db_ids else
            ("%s: part dirs subset of db ids" % st if names < db_ids else "%s: part dirs other" % st)] += 1
        for s in subs:
            p = os.path.join(adir, s)
            if os.path.islink(p):
                att["symlink part dir"] += 1
                continue
            if not os.path.isdir(p):
                att["non-dir entry"] += 1
                continue
            if not PART_RE.match(s):
                att["part dir name not a part number"] += 1
            try:
                files = os.listdir(p)
            except OSError:
                continue
            regular = [f for f in files if os.path.isfile(os.path.join(p, f)) and not os.path.islink(os.path.join(p, f))]
            att["part dir with %s regular files" % (len(regular) if len(regular) < 3 else "3+")] += 1
            if len(files) != len(regular):
                att["part dir with non-regular entries"] += 1
            for f in regular:
                try:
                    n = os.stat(os.path.join(p, f)).st_size
                except OSError:
                    continue
                att_size[EXTENSIONS.get(ext_of(f), ext_of(f))][size_bucket(n)] += 1
    order = [b for _, b in SIZE_BUCKETS] + [">=20M"]
    out("local file: %s" % counter_line(state, len(newest)))
    for st in sorted(emlx_size):
        out("emlx size, %s: %s" % (st, counter_line(emlx_size[st], None, order)))
    for k in sorted(att):
        out("%s: %d" % (k, att[k]))
    for k in sorted(att_size):
        out("attachment file size, %s: %s" % (k, counter_line(att_size[k], None, order)))

    header(9, "All Attachments directories under the store")
    dirs = files = size = 0
    big = collections.Counter()
    for dp, dns, fns in os.walk(vdir):
        if os.path.basename(dp) == "Attachments":
            dirs += 1
            for adp, _, afns in os.walk(dp):
                for f in afns:
                    try:
                        n = os.lstat(os.path.join(adp, f)).st_size
                    except OSError:
                        continue
                    files += 1
                    size += n
                    big[size_bucket(n)] += 1
            dns[:] = []
    out("Attachments directories: %d, files: %d, total %.1f MiB" % (dirs, files, size / MIB))
    out("file sizes: %s" % counter_line(big, None, [b for _, b in SIZE_BUCKETS] + [">=20M"]))


# --------------------------------------------------------------------------- Lauf

def run(args):
    ver = find_version_dir(args.root)
    if not ver:
        out("no V<n> directory in ~/Library/Mail")
        return 1
    vdir = ver[1]
    idx = os.path.join(vdir, "MailData", "Envelope Index")
    out("Categories and attachments check (AMM-13)")
    out("macOS %s, store version dir: V%d" % (platform.mac_ver()[0] or "?", ver[0]))
    con = open_ro(idx)
    boxes, labels = load_mailboxes(con)
    out("accounts: %d, mailboxes: %d, inboxes: %d" % (len(labels), len(boxes), sum(b.is_inbox for b in boxes.values())))
    run_categories(con, boxes, labels, vdir)
    run_attachments(con, boxes, vdir, args.sample)
    out()
    out("done")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Count Apple Intelligence categories and attachment storage (read-only).")
    ap.add_argument("--root", default=os.path.join(HOME, "Library", "Mail"))
    ap.add_argument("--sample", type=int, default=2000)
    args = ap.parse_args()
    try:
        os.listdir(args.root)
    except OSError:
        out("no access to ~/Library/Mail")
        return 2
    try:
        return run(args)
    except KeyboardInterrupt:
        out("interrupted")
        return 130
    except Exception as e:
        out("ERROR: %s" % type(e).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
