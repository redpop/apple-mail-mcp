#!/usr/bin/python3 -I
# Pruefskript fuer AMM-10: Warum finden manche Konto-UUIDs aus mailboxes.url keine Zeile in
# Accounts4, und gibt es eine zweite feste Quelle fuer Kontonamen? Martin startet es selbst aus
# einem Terminal mit Full Disk Access:
#   /usr/bin/python3 -I scripts/check-account-names.py
#
# Datenschutz: Die Ausgabe enthaelt nur Zaehler, Ja/Nein-Werte, Schemata, Apple-Typkennungen,
# Tabellen-, Spalten- und Schluesselnamen. Keine UUIDs (Konten heissen A1, A2, ... in der
# Reihenfolge ihrer kleinsten Mailbox-ROWID), keine Namen, Adressen, Beschreibungen oder
# Mailboxnamen. Jede Zeile laeuft durch out(); dort werden $HOME, Adressen und UUIDs
# geschwaerzt. Alles ist lesend (SQLite per URI mode=ro, nie immutable). Es wird nichts
# geschrieben, auch kein Bericht.
#
# Optionen (NUR FUER SELBSTTESTS mit synthetischen Daten):
#   --root DIR       Standard: ~/Library/Mail
#   --accounts FILE  Standard: ~/Library/Accounts/Accounts4.sqlite
#   --prefs PATH ... Standard: ~/Library/Preferences und der Preferences-Ordner im Mail-Container
import argparse
import collections
import os
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
APPLE_ID_RE = re.compile(r"^com\.apple\.[A-Za-z0-9.]{1,80}$")
EMLX_RE = re.compile(r"^\d+(\.partial)?\.emlx$")
MAX_PLIST = 20 * 1024 * 1024
MAX_SCAN_ROWS = 20000


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
    return "n/a" if not b else "%.1f%% (%d/%d)" % (100.0 * a / b, a, b)


def yn(v):
    return "-" if v is None else ("yes" if v else "no")


def safe_ident(s):
    """Tabellen-, Spalten- und Plist-Schluessel: nur schlichte Namen, sonst <other>."""
    if UUID_RE.match(s):
        return "<uuid>"
    return s if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,60}", s) else "<other>"


def safe_type(s):
    return s if isinstance(s, str) and APPLE_ID_RE.match(s) else ("-" if s is None else "<other>")


def safe_file(name):
    if UUID_RE.match(name.split(".")[0]):
        return "<uuid>" + name[len(name.split(".")[0]):]
    return name if re.fullmatch(r"[A-Za-z][A-Za-z0-9 ._-]{0,60}", name) else "<other>"


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


def account_of(url):
    """-> (schema klein, host) wie MailStore.accountUUID, ohne Schemafilter."""
    p = urllib.parse.urlsplit(url or "")
    return p.scheme.lower(), p.netloc


def nonempty(v):
    return isinstance(v, str) and v.strip() != ""


# --------------------------------------------------------------------------- Envelope Index

class Acct:
    def __init__(self, uuid):
        self.uuid = uuid
        self.schemes = collections.Counter()
        self.mailboxes = 0
        self.min_rowid = None
        self.total = 0
        self.rows = 0
        self.row = None          # ZACCOUNT-Zeile oder None
        self.label = ""
        self.disk_dir = False
        self.emlx = 0
        self.mbox_dirs = 0
        self.sources = set()     # Kandidatenquellen, in denen die UUID vorkommt


def load_accounts(con):
    accts = {}
    for rid, url, total in con.execute("SELECT ROWID, url, total_count FROM mailboxes ORDER BY ROWID"):
        scheme, host = account_of(url)
        if not host:
            continue
        a = accts.setdefault(host, Acct(host))
        a.schemes[scheme] += 1
        a.mailboxes += 1
        a.total += total or 0
        a.min_rowid = rid if a.min_rowid is None else a.min_rowid
    by_mailbox = {}
    for rid, url in con.execute("SELECT ROWID, url FROM mailboxes"):
        by_mailbox[rid] = account_of(url)[1]
    for mb, n in con.execute("SELECT mailbox, count(*) FROM messages GROUP BY mailbox"):
        host = by_mailbox.get(mb)
        if host in accts:
            accts[host].rows += n
    ordered = sorted(accts.values(), key=lambda a: a.min_rowid)
    for i, a in enumerate(ordered, 1):
        a.label = "A%d" % i
    return ordered


# --------------------------------------------------------------------------- Accounts4

def columns(con, table):
    return [r[1] for r in con.execute("PRAGMA table_info(%s)" % table)]


def load_accounts4(path, accts):
    """Liest ZACCOUNT-Zeilen fuer die Mail-UUIDs plus Typ und Elternkonto."""
    con = open_ro(path)
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    cols = set(columns(con, "ZACCOUNT"))
    want = ["Z_PK", "ZIDENTIFIER", "ZACCOUNTDESCRIPTION", "ZUSERNAME", "ZACTIVE", "ZVISIBLE",
            "ZACCOUNTTYPE", "ZPARENTACCOUNT", "ZOWNINGBUNDLEID"]
    sel = [c if c in cols else "NULL" for c in want]
    rows = {}
    by_pk = {}
    for r in con.execute("SELECT %s FROM ZACCOUNT" % ", ".join(sel)):
        d = dict(zip(want, r))
        by_pk[d["Z_PK"]] = d
        if d["ZIDENTIFIER"]:
            rows[d["ZIDENTIFIER"].upper()] = d
    types = {}
    if "ZACCOUNTTYPE" in tables and "ZIDENTIFIER" in columns(con, "ZACCOUNTTYPE"):
        for pk, ident in con.execute("SELECT Z_PK, ZIDENTIFIER FROM ZACCOUNTTYPE"):
            types[pk] = ident
    for a in accts:
        a.row = rows.get(a.uuid.upper())
    return con, tables, by_pk, types


def scan_db_for(con, tables, needles, skip=()):
    """Sucht UUIDs als Text oder Bytes in allen Spalten kleiner Tabellen. -> {uuid: set(tab.col)}"""
    hits = collections.defaultdict(set)
    skipped = []
    up = {u: (u.upper(), u.upper().encode()) for u in needles}
    for t in tables:
        if t in skip or t.startswith("sqlite_"):
            continue
        try:
            n = con.execute('SELECT count(*) FROM "%s"' % t.replace('"', '""')).fetchone()[0]
        except sqlite3.Error:
            continue
        if n > MAX_SCAN_ROWS:
            skipped.append((t, n))
            continue
        cols = columns(con, '"%s"' % t.replace('"', '""'))
        for row in con.execute('SELECT * FROM "%s"' % t.replace('"', '""')):
            for c, v in zip(cols, row):
                if isinstance(v, str):
                    s = v.upper()
                    for u, (us, _) in up.items():
                        if us in s:
                            hits[u].add("%s.%s" % (safe_ident(t), safe_ident(c)))
                elif isinstance(v, bytes):
                    b = v.upper()
                    for u, (_, ub) in up.items():
                        if ub in b:
                            hits[u].add("%s.%s(blob)" % (safe_ident(t), safe_ident(c)))
    return hits, skipped


def property_keys_for(con, tables, by_uuid_pk):
    """ZACCOUNTPROPERTY-Schluessel je Konto (nur Schluesselnamen)."""
    if "ZACCOUNTPROPERTY" not in tables:
        return {}
    cols = set(columns(con, "ZACCOUNTPROPERTY"))
    if not {"ZOWNER", "ZKEY"}.issubset(cols):
        return {}
    keys = collections.defaultdict(set)
    for owner, key in con.execute("SELECT ZOWNER, ZKEY FROM ZACCOUNTPROPERTY"):
        if owner in by_uuid_pk and isinstance(key, str):
            keys[by_uuid_pk[owner]].add(safe_ident(key))
    return keys


# --------------------------------------------------------------------------- Plists

def walk_plist(obj, needles, path, hits):
    """Sammelt (uuid, schluesselpfad, geschwister-schluessel mit nicht leerem Text)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            ks = str(k)
            for u in needles:
                if u in ks.upper():
                    # Bei einem Schluessel zaehlen die Schluessel darunter, nicht die daneben.
                    inner = sibling_info(v) if isinstance(v, dict) else sibling_info(obj)
                    hits.append((u, path + [safe_ident(ks)] + ["(key)"], inner))
            walk_plist(v, needles, path + [safe_ident(ks)], hits)
            if isinstance(v, str):
                for u in needles:
                    if u in v.upper():
                        hits.append((u, path + [safe_ident(ks)], sibling_info(obj)))
    elif isinstance(obj, list):
        for v in obj:
            walk_plist(v, needles, path + ["[]"], hits)
            if isinstance(v, str):
                for u in needles:
                    if u in v.upper():
                        hits.append((u, path + ["[]"], []))


def sibling_info(d):
    return sorted("%s%s" % (safe_ident(str(k)), "*" if nonempty(v) else "")
                  for k, v in d.items())


def plist_files(paths):
    for d in paths:
        if os.path.isfile(d) and d.endswith(".plist"):
            yield os.path.dirname(d), d
            continue
        if not os.path.isdir(d):
            continue
        for dp, dns, fns in os.walk(d):
            for fn in fns:
                if fn.endswith(".plist"):
                    yield d, os.path.join(dp, fn)


def scan_plists(label, dirs, accts, results):
    needles = [a.uuid.upper() for a in accts]
    by_uuid = {a.uuid.upper(): a for a in accts}
    files = parsed = failed = 0
    per_file = []
    for base, p in plist_files(dirs):
        files += 1
        try:
            if os.path.getsize(p) > MAX_PLIST:
                failed += 1
                continue
            with open(p, "rb") as f:
                data = plistlib.load(f)
            parsed += 1
        except Exception:
            failed += 1
            continue
        hits = []
        walk_plist(data, needles, [], hits)
        if not hits:
            continue
        rel = os.path.relpath(p, base).split(os.sep)
        name = "/".join(safe_file(c) for c in rel)
        uu = set(h[0] for h in hits)
        for u in uu:
            by_uuid[u].sources.add("%s:%s" % (label, name))
        shapes = collections.Counter()
        for u, kp, sib in hits:
            shapes[("/".join(kp), ", ".join(sib))] += 1
        per_file.append((name, uu, shapes))
    out("%s: plist files %d, parsed %d, failed %d, files mentioning a mail account UUID: %d"
        % (label, files, parsed, failed, len(per_file)))
    for name, uu, shapes in per_file:
        m = sum(1 for u in uu if by_uuid[u].row is not None)
        out("  %s: UUIDs matched in Accounts4 %d, unmatched %d" % (name, m, len(uu) - m))
        for (kp, sib), n in shapes.most_common(8):
            out("    %d x key path %s" % (n, kp or "(root)"))
            if sib:
                out("       sibling keys (* = non-empty text): %s" % sib)
    results[label] = per_file


# --------------------------------------------------------------------------- Ablage

def scan_disk(vdir, accts):
    for a in accts:
        d = os.path.join(vdir, a.uuid)
        if not os.path.isdir(d):
            continue
        a.disk_dir = True
        for dp, dns, fns in os.walk(d):
            dns[:] = [x for x in dns if x != "Attachments"]
            if dp.endswith(".mbox"):
                a.mbox_dirs += 1
            a.emlx += sum(1 for f in fns if EMLX_RE.match(f))


# --------------------------------------------------------------------------- Lauf

def run(args):
    ver = find_version_dir(args.root)
    if not ver:
        out("no V<n> directory in ~/Library/Mail")
        return 1
    vdir = ver[1]
    out("Account names check (AMM-10)")
    out("store version dir: V%d" % ver[0])

    header(1, "mail accounts from mailboxes.url")
    try:
        env = open_ro(os.path.join(vdir, "MailData", "Envelope Index"))
        accts = load_accounts(env)
    except Exception as e:
        out("cannot read Envelope Index: %s" % type(e).__name__)
        return 1
    schemes = collections.Counter(s for a in accts for s in a.schemes)
    out("account hosts: %d; by scheme (accounts having at least one mailbox): %s"
        % (len(accts), ", ".join("%s=%d" % kv for kv in sorted(schemes.items()))))
    out("hosts that look like a UUID: %s" % pct(sum(1 for a in accts if UUID_RE.match(a.uuid)), len(accts)))

    header(2, "Accounts4")
    a4 = None
    try:
        a4, tables, by_pk, types = load_accounts4(args.accounts, accts)
    except Exception as e:
        out("cannot read Accounts4: %s" % type(e).__name__)
        tables, by_pk, types = [], {}, {}
    matched = [a for a in accts if a.row is not None]
    out("matched in ZACCOUNT.ZIDENTIFIER (case-insensitive): %s" % pct(len(matched), len(accts)))
    if a4 is not None:
        out("Accounts4 tables: %s" % ", ".join(safe_ident(t) for t in sorted(tables)))
        mail_types = collections.Counter(safe_type(types.get(r["ZACCOUNTTYPE"]))
                                         for r in by_pk.values())
        out("all ZACCOUNT rows by type (type=count): %s"
            % ", ".join("%s=%d" % kv for kv in sorted(mail_types.items())))
        mail_like = [r for r in by_pk.values()
                     if re.search(r"(?i)imap|mail|exchange|local|onmymac|pop|gmail|google|yahoo|aol|icloud|mobileme",
                                  types.get(r["ZACCOUNTTYPE"]) or "")]
        listed = set(a.uuid.upper() for a in accts)
        out("ZACCOUNT rows of a mail-like type: %d, of those not in mailboxes.url: %d"
            % (len(mail_like), sum(1 for r in mail_like if (r["ZIDENTIFIER"] or "").upper() not in listed)))

    scan_disk(vdir, accts)
    header(3, "per account (A<n> ordered by smallest mailbox ROWID; no UUIDs printed)")
    out("label scheme   mbx  total_count  msg_rows  dir_on_disk  .mbox  .emlx  | A4row desc  user  user@  active visible type / parent(type, desc)")
    for a in accts:
        r = a.row
        parent = None
        if r is not None and r.get("ZPARENTACCOUNT") in by_pk:
            parent = by_pk[r["ZPARENTACCOUNT"]]
        ptxt = "-" if parent is None else "%s, desc %s" % (
            safe_type(types.get(parent["ZACCOUNTTYPE"])), yn(nonempty(parent["ZACCOUNTDESCRIPTION"])))
        out("%-5s %-8s %4d %12d %9d  %-11s %6d %6d  | %-5s %-5s %-5s %-5s %-6s %-7s %s / %s" % (
            a.label, "+".join(sorted(a.schemes)), a.mailboxes, a.total, a.rows, yn(a.disk_dir),
            a.mbox_dirs, a.emlx, yn(r is not None),
            yn(None if r is None else nonempty(r["ZACCOUNTDESCRIPTION"])),
            yn(None if r is None else nonempty(r["ZUSERNAME"])),
            yn(None if r is None else "@" in (r["ZUSERNAME"] or "")),
            "-" if r is None else str(r["ZACTIVE"]), "-" if r is None else str(r["ZVISIBLE"]),
            "-" if r is None else safe_type(types.get(r["ZACCOUNTTYPE"])), ptxt))

    header(4, "store directories")
    for group, items in (("matched", matched), ("unmatched", [a for a in accts if a.row is None])):
        out("%s: %d; with V<n>/<uuid> directory %d; with .emlx files %d; with message rows %d; total_count > 0: %d"
            % (group, len(items), sum(a.disk_dir for a in items), sum(a.emlx > 0 for a in items),
               sum(a.rows > 0 for a in items), sum(a.total > 0 for a in items)))

    header(5, "UUIDs elsewhere in Accounts4 (all small tables, text and blob columns)")
    unmatched = [a for a in accts if a.row is None]
    if a4 is not None:
        hits, skipped = scan_db_for(a4, tables, [a.uuid for a in accts])
        for t, n in skipped:
            out("skipped table %s (%d rows)" % (safe_ident(t), n))
        for a in accts:
            cols = sorted(hits.get(a.uuid, ()))
            if a.row is not None:
                cols = [c for c in cols if c != "ZACCOUNT.ZIDENTIFIER"]
            if cols:
                a.sources.add("Accounts4:" + "+".join(cols))
            out("  %s (%s): %s" % (a.label, "matched" if a.row is not None else "unmatched",
                                   ", ".join(cols) or "no other column"))
        pk_to_label = {r["Z_PK"]: a.label for a in accts for r in [a.row] if r is not None}
        keys = property_keys_for(a4, tables, pk_to_label)
        for lbl in sorted(keys, key=lambda s: int(s[1:])):
            out("  ZACCOUNTPROPERTY keys of %s: %s" % (lbl, ", ".join(sorted(keys[lbl]))))

    header(6, "UUIDs in other Envelope Index tables (small tables only)")
    env_tables = [r[0] for r in env.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    ehits, eskipped = scan_db_for(env, env_tables, [a.uuid for a in accts], skip=("mailboxes",))
    out("skipped large tables: %s" % (", ".join("%s(%d)" % (safe_ident(t), n) for t, n in eskipped) or "none"))
    for a in accts:
        cols = sorted(ehits.get(a.uuid, ()))
        if cols:
            a.sources.add("EnvelopeIndex:" + "+".join(cols))
        out("  %s: %s" % (a.label, ", ".join(cols) or "none"))

    header(7, "UUIDs in plists (values never printed)")
    results = {}
    scan_plists("MailData", [os.path.join(vdir, "MailData")], accts, results)
    scan_plists("prefs", args.prefs, accts, results)

    header(8, "summary: which source mentions which unmatched account")
    src_count = collections.Counter()
    for a in unmatched:
        for s in a.sources:
            src_count[s] += 1
    out("unmatched accounts: %d" % len(unmatched))
    out("  local scheme: %d, imap: %d, ews: %d, other: %d" % (
        sum("local" in a.schemes for a in unmatched), sum("imap" in a.schemes for a in unmatched),
        sum("ews" in a.schemes for a in unmatched),
        sum(not ({"local", "imap", "ews"} & set(a.schemes)) for a in unmatched)))
    out("  without V<n>/<uuid> directory: %d; without message rows: %d; without .emlx: %d" % (
        sum(not a.disk_dir for a in unmatched), sum(a.rows == 0 for a in unmatched),
        sum(a.emlx == 0 for a in unmatched)))
    out("  mentioned in no candidate source: %d" % sum(not a.sources for a in unmatched))
    for s, n in src_count.most_common():
        out("  source %s: %d of %d" % (s, n, len(unmatched)))
    nodesc = [a for a in matched if not nonempty(a.row["ZACCOUNTDESCRIPTION"])]
    out("matched without ZACCOUNTDESCRIPTION: %d (with non-empty ZUSERNAME: %d, with '@': %d)" % (
        len(nodesc), sum(nonempty(a.row["ZUSERNAME"]) for a in nodesc),
        sum("@" in (a.row["ZUSERNAME"] or "") for a in nodesc)))
    return 0


def main():
    container = os.path.join(HOME, "Library", "Containers", "com.apple.mail", "Data", "Library", "Preferences")
    ap = argparse.ArgumentParser(description="Check where Mail account names can come from (read-only).")
    ap.add_argument("--root", default=os.path.join(HOME, "Library", "Mail"))
    ap.add_argument("--accounts", default=os.path.join(HOME, "Library", "Accounts", "Accounts4.sqlite"))
    ap.add_argument("--prefs", nargs="*", default=None)
    args = ap.parse_args()
    if args.prefs is None:
        prefs = os.path.join(HOME, "Library", "Preferences")
        # Aus dem allgemeinen Preferences-Ordner nur Mails eigene Dateien.
        args.prefs = [container] + [os.path.join(prefs, f) for f in ("com.apple.mail.plist", "com.apple.mail-shared.plist")]
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
