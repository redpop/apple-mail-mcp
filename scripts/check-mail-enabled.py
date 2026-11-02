#!/usr/bin/python3 -I
# Pruefskript fuer AMM-21: Ein Konto steht in Accounts4 und hat ein Store-Verzeichnis, Mail zeigt es
# aber nicht an (vermutlich in den Internetaccounts fuer Mail abgeschaltet). Unterscheidet es sich
# durch ein festes Merkmal (ZACTIVE, ZVISIBLE, Mail-Dataclass aktiviert oder provisioniert,
# Elternkonto) von den anderen lebenden Konten? Martin startet es selbst aus einem Terminal mit
# Full Disk Access:
#   /usr/bin/python3 -I scripts/check-mail-enabled.py
#
# Datenschutz: Die Ausgabe enthaelt nur Zaehler, Ja/Nein-Werte, Ganzzahlen aus ZACCOUNT,
# Apple-Typkennungen, Tabellen- und Spaltennamen. Keine UUIDs (Konten heissen A1, A2, ... in der
# Reihenfolge ihrer kleinsten Mailbox-ROWID, wie in check-account-names.py), keine Namen,
# Adressen, Beschreibungen oder Mailboxnamen. Jede Zeile laeuft durch out(); dort werden $HOME,
# Adressen und UUIDs geschwaerzt. Alles ist lesend (SQLite per URI mode=ro, nie immutable). Es
# wird nichts geschrieben, auch kein Bericht.
#
# Dataclasses: Die Verknuepfungsspalte Z_<ent>...DATACLASSES zeigt auf Entitaet <ent>; ihre Tabelle
# wird ueber Z_PRIMARYKEY (Z_NAME, Z_SUPER) gesucht, nicht als ZDATACLASS angenommen.
#
# Optionen (NUR FUER SELBSTTESTS mit synthetischen Daten):
#   --root DIR       Standard: ~/Library/Mail
#   --accounts FILE  Standard: ~/Library/Accounts/Accounts4.sqlite
#   --selftest       baut synthetische Daten in einem Temp-Ordner und prueft die Ausgabe
import argparse
import collections
import contextlib
import io
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse

HOME = os.path.expanduser("~")
UUID_PAT = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
UUID_RE = re.compile("^" + UUID_PAT + "$")
UUID_ANY = re.compile(UUID_PAT)
EMAIL_RE = re.compile(r"[^\s@<>\"']+@[^\s@<>\"']+")
APPLE_ID_RE = re.compile(r"^com\.apple\.[A-Za-z0-9.]{1,80}$")
EMLX_RE = re.compile(r"^\d+(\.partial)?\.emlx$")
MAIL_DATACLASS = "com.apple.Dataclass.Mail"
DATACLASS_RE = re.compile(r"^com\.apple\.Dataclass\.[A-Za-z0-9.]+$")
DATACLASS_PREFIX = "com.apple.Dataclass."
# Ganzzahlspalten von ZACCOUNT, die nichts ueber das Konto sagen oder Fremdschluessel sind.
SKIP_INT_COLS = {"Z_PK", "Z_OPT", "ZPARENTACCOUNT", "ZACCOUNTTYPE"}


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


def yn(v):
    return "-" if v is None else ("yes" if v else "no")


def safe_ident(s):
    """Tabellen- und Spaltennamen: nur schlichte Namen, sonst <other>."""
    if UUID_RE.match(s):
        return "<uuid>"
    return s if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,60}", s) else "<other>"


def safe_type(s):
    return s if isinstance(s, str) and APPLE_ID_RE.match(s) else ("-" if s is None else "<other>")


def safe_int(v):
    return str(v) if isinstance(v, int) and not isinstance(v, bool) else ("-" if v is None else "<non-int>")


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


def columns(con, table):
    return [r[1] for r in con.execute('PRAGMA table_info("%s")' % table.replace('"', '""'))]


def column_types(con, table):
    return {r[1]: (r[2] or "").upper() for r in con.execute('PRAGMA table_info("%s")' % table.replace('"', '""'))}


# --------------------------------------------------------------------------- Envelope Index

class Acct:
    def __init__(self, uuid):
        self.uuid = uuid
        self.schemes = collections.Counter()
        self.mailboxes = 0
        self.min_rowid = None
        self.label = ""
        self.row = None          # ZACCOUNT-Zeile oder None
        self.has_store = False
        self.emlx = 0


def load_accounts(con):
    """Gleiche Zaehlung wie check-account-names.py, damit A<n> dasselbe Konto meint."""
    accts = {}
    for rid, url in con.execute("SELECT ROWID, url FROM mailboxes ORDER BY ROWID"):
        scheme, host = account_of(url)
        if not host:
            continue
        a = accts.setdefault(host, Acct(host))
        a.schemes[scheme] += 1
        a.mailboxes += 1
        a.min_rowid = rid if a.min_rowid is None else a.min_rowid
    ordered = sorted(accts.values(), key=lambda a: a.min_rowid)
    for i, a in enumerate(ordered, 1):
        a.label = "A%d" % i
    return ordered


def scan_disk(vdir, accts):
    for a in accts:
        d = os.path.join(vdir, a.uuid)
        if not os.path.isdir(d):
            continue
        a.has_store = True
        for dp, dns, fns in os.walk(d):
            dns[:] = [x for x in dns if x != "Attachments"]
            a.emlx += sum(1 for f in fns if EMLX_RE.match(f))


# --------------------------------------------------------------------------- Accounts4

def find_link_table(con, tables, kind):
    """Sucht die CoreData-Verknuepfungstabelle Z_<n><kind>DATACLASSES und ihre zwei Spalten.

    -> (tabelle, konto-spalte, dataclass-spalte) oder (tabelle|None, None, None) mit Grund."""
    pat = re.compile(r"^Z_\d+%sDATACLASSES$" % kind)
    cands = [t for t in tables if pat.match(t)]
    if len(cands) != 1:
        return None, None, None, "%d tables match Z_<n>%sDATACLASSES" % (len(cands), kind)
    t = cands[0]
    cols = columns(con, t)
    acc = [c for c in cols if re.fullmatch(r"Z_\d+%sACCOUNTS" % kind, c)]
    dc = [c for c in cols if re.fullmatch(r"Z_\d+%sDATACLASSES" % kind, c)]
    if len(acc) != 1 or len(dc) != 1:
        return t, None, None, "unexpected columns: %s" % ", ".join(safe_ident(c) for c in cols)
    return t, acc[0], dc[0], None


def load_links(con, table, acc_col, dc_col):
    """-> {account Z_PK: set(Z_PK der Dataclass-Entitaet)}"""
    res = collections.defaultdict(set)
    q = 'SELECT "%s", "%s" FROM "%s"' % (acc_col, dc_col, table)
    for apk, dpk in con.execute(q):
        res[apk].add(dpk)
    return res


def load_entities(con, tables):
    """Z_PRIMARYKEY -> {Z_ENT: (Z_NAME, Z_SUPER)}"""
    if "Z_PRIMARYKEY" not in tables:
        return {}
    sup = '"Z_SUPER"' if "Z_SUPER" in columns(con, "Z_PRIMARYKEY") else "0"
    return {e: (n, s) for e, n, s in con.execute("SELECT Z_ENT, Z_NAME, %s FROM Z_PRIMARYKEY" % sup)}


def resolve_entity(con, tables, entities, ent, wanted):
    """Bildet eine CoreData-Entitaet auf Tabelle und Kennungsspalte ab.

    CoreData legt Unterentitaeten in der Tabelle der Wurzelentitaet ab. Darum kommen die Tabellen
    der Entitaet und aller Oberentitaeten in Frage; gewaehlt wird die, in der die meisten
    verknuepften Z_PK eine Kennung haben. -> (tabelle|None, spalte|None, {Z_PK: kennung}, notizen)"""
    notes = []
    if ent not in entities:
        return None, None, {}, ["entity %d not in Z_PRIMARYKEY" % ent]
    chain, e = [], ent
    while e in entities and e not in chain:
        chain.append(e)
        e = entities[e][1]
    upper = {t.upper(): t for t in tables}
    best = (None, None, {}, -1)
    for e in chain:
        name = entities[e][0]
        t = upper.get("Z" + name.upper()) if isinstance(name, str) else None
        if t is None:
            notes.append("entity %d (%s): no table" % (e, safe_ident(str(name))))
            continue
        cols = columns(con, t)
        if "ZIDENTIFIER" not in cols:
            notes.append("entity %d: table %s has no ZIDENTIFIER (columns: %s)"
                         % (e, safe_ident(t), ", ".join(safe_ident(c) for c in cols)))
            continue
        ids = dict(con.execute('SELECT Z_PK, ZIDENTIFIER FROM "%s"' % t))
        hit = sum(1 for pk in wanted if pk in ids)
        notes.append("entity %d: table %s, rows %d, linked Z_PK found %d of %d"
                     % (e, safe_ident(t), len(ids), hit, len(wanted)))
        if hit > best[3]:
            best = (t, "ZIDENTIFIER", ids, hit)
    return best[0], best[1], best[2], notes


def short_dc(ident):
    """Kennung fuer die Ausgabe: nur com.apple.Dataclass.*, ohne Praefix; sonst other."""
    if ident is None:
        return "unresolved"
    if isinstance(ident, str) and DATACLASS_RE.match(ident):
        return ident[len(DATACLASS_PREFIX):]
    return "other"


def fmt_dcs(ids):
    if ids is None:
        return "-"
    c = collections.Counter(short_dc(i) for i in ids)
    named = sorted(k for k in c if k not in ("other", "unresolved"))
    extra = ["%s x%d" % (k, c[k]) for k in ("other", "unresolved") if c[k]]
    return ", ".join(named + extra) or "none"


class Accounts4:
    def __init__(self, path, accts):
        self.con = open_ro(path)
        con = self.con
        self.tables = sorted(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'"))
        ctypes = column_types(con, "ZACCOUNT")
        # Ganzzahlspalten fuer den Vergleich am Ende, ohne Fremdschluessel und Verwaltungsspalten.
        self.int_cols = sorted(c for c, t in ctypes.items() if "INT" in t and c not in SKIP_INT_COLS)
        want = ["Z_PK", "ZIDENTIFIER", "ZACTIVE", "ZVISIBLE", "ZACCOUNTTYPE", "ZPARENTACCOUNT"]
        sel = want + [c for c in self.int_cols if c not in want]
        exprs = ['"%s"' % c if c in ctypes else "NULL" for c in sel]
        self.by_pk = {}
        by_ident = {}
        for r in con.execute("SELECT %s FROM ZACCOUNT" % ", ".join(exprs)):
            d = dict(zip(sel, r))
            self.by_pk[d["Z_PK"]] = d
            if isinstance(d["ZIDENTIFIER"], str):
                by_ident[d["ZIDENTIFIER"].upper()] = d
        for a in accts:
            a.row = by_ident.get(a.uuid.upper())
        self.types = {}
        if "ZACCOUNTTYPE" in self.tables and "ZIDENTIFIER" in columns(con, "ZACCOUNTTYPE"):
            self.types = dict(con.execute("SELECT Z_PK, ZIDENTIFIER FROM ZACCOUNTTYPE"))
        self.entities = load_entities(con, self.tables)
        self.links = {}
        self.link_info = {}
        self.resolved = {}
        for kind in ("ENABLED", "PROVISIONED"):
            t, ac, dc, err = find_link_table(con, self.tables, kind)
            self.link_info[kind] = (t, ac, dc, err)
            self.links[kind] = load_links(con, t, ac, dc) if err is None else None
            self.resolved[kind] = (None, None, {}, [])
            if err is None:
                # Die Dataclass-Spalte heisst Z_<ent>...; <ent> ist die Zielentitaet.
                ent = int(re.match(r"Z_(\d+)", dc).group(1))
                wanted = set(pk for v in self.links[kind].values() for pk in v)
                self.resolved[kind] = (ent,) + resolve_entity(con, self.tables, self.entities, ent, wanted)

    def flags(self, row):
        """-> dict mit active, visible, mail enabled/provisioned und Zahl der Dataclasses."""
        if row is None:
            return None
        pk = row["Z_PK"]
        f = {"active": row["ZACTIVE"], "visible": row["ZVISIBLE"], "type": self.types.get(row["ZACCOUNTTYPE"])}
        for kind in ("ENABLED", "PROVISIONED"):
            links = self.links[kind]
            if links is None:
                f[kind] = None
                f[kind + "_n"] = None
                f[kind + "_ids"] = None
            else:
                names = self.resolved[kind][3]
                ids = [names.get(d) for d in links.get(pk, ())]
                f[kind] = MAIL_DATACLASS in ids
                f[kind + "_n"] = len(ids)
                f[kind + "_ids"] = ids
        return f

    def parent(self, row):
        if row is None:
            return None
        return self.by_pk.get(row["ZPARENTACCOUNT"])


# --------------------------------------------------------------------------- Lauf

def fmt_flags(f):
    if f is None:
        return "%-6s %-7s %-8s %-8s %-6s %-6s" % ("-", "-", "-", "-", "-", "-")
    return "%-6s %-7s %-8s %-8s %-6s %-6s" % (
        safe_int(f["active"]), safe_int(f["visible"]), yn(f["ENABLED"]), yn(f["PROVISIONED"]),
        "-" if f["ENABLED_n"] is None else f["ENABLED_n"],
        "-" if f["PROVISIONED_n"] is None else f["PROVISIONED_n"])


def run(args):
    ver = find_version_dir(args.root)
    if not ver:
        out("no V<n> directory in ~/Library/Mail")
        return 1
    vdir = ver[1]
    out("Mail enabled check (AMM-21)")
    out("store version dir: V%d" % ver[0])

    header(1, "mail accounts from mailboxes.url")
    try:
        env = open_ro(os.path.join(vdir, "MailData", "Envelope Index"))
        accts = load_accounts(env)
    except Exception as e:
        out("cannot read Envelope Index: %s" % type(e).__name__)
        return 1
    scan_disk(vdir, accts)
    out("account hosts: %d; with V<n>/<uuid> directory: %d" % (len(accts), sum(a.has_store for a in accts)))

    header(2, "Accounts4 layout")
    try:
        a4 = Accounts4(args.accounts, accts)
    except Exception as e:
        out("cannot read Accounts4: %s" % type(e).__name__)
        a4 = None
    if a4 is not None:
        out("ZACCOUNT rows: %d" % len(a4.by_pk))
        out("Z_PRIMARYKEY entities (Z_ENT name super): %s" % (", ".join(
            "%d %s %s" % (e, safe_ident(str(n)), s) for e, (n, s) in sorted(a4.entities.items())) or "none"))
        for kind in ("ENABLED", "PROVISIONED"):
            t, ac, dc, err = a4.link_info[kind]
            if err:
                out("%s link table: %s%s" % (kind.lower(), "" if t is None else safe_ident(t) + ": ", err))
            else:
                out("%s link table: %s(%s, %s), rows %d" % (
                    kind.lower(), safe_ident(t), safe_ident(ac), safe_ident(dc),
                    sum(len(v) for v in a4.links[kind].values())))
                ent, rt, rc, names, notes = a4.resolved[kind]
                for n in notes:
                    out("  target %s" % n)
                out("  target entity %d -> table %s, identifier column %s; '%s' present: %s" % (
                    ent, "-" if rt is None else safe_ident(rt), rc or "-", MAIL_DATACLASS,
                    yn(MAIL_DATACLASS in names.values())))
        out("ZACCOUNT integer columns compared below: %s" % (", ".join(safe_ident(c) for c in a4.int_cols) or "none"))

    header(3, "per account (A<n> ordered by smallest mailbox ROWID, same as check-account-names.py)")
    out("mailEn/mailProv: Mail dataclass enabled/provisioned; nEn/nProv: number of dataclasses linked")
    out("label scheme   mbx  store  .emlx  | A4row active visible mailEn   mailProv nEn    nProv  "
        "| parent active visible mailEn   mailProv nEn    nProv  | type / parent type")
    rows = []
    for a in accts:
        r = a.row
        f = a4.flags(r) if a4 is not None else None
        p = a4.parent(r) if a4 is not None else None
        pf = a4.flags(p) if a4 is not None else None
        rows.append((a, f, p, pf))
        out("%-5s %-8s %4d  %-5s %6d  | %-5s %s | %-6s %s | %s / %s" % (
            a.label, "+".join(sorted(a.schemes)), a.mailboxes, yn(a.has_store), a.emlx,
            yn(r is not None), fmt_flags(f), yn(None if r is None else p is not None), fmt_flags(pf),
            "-" if f is None else safe_type(f["type"]), "-" if pf is None else safe_type(pf["type"])))

    out()
    out("dataclasses per account (prefix com.apple.Dataclass. removed; other = not matching that pattern)")
    for a, f, p, pf in rows:
        if f is None:
            continue
        out("%-5s own enabled: %s; own provisioned: %s" % (a.label, fmt_dcs(f["ENABLED_ids"]), fmt_dcs(f["PROVISIONED_ids"])))
        if pf is not None:
            out("%-5s parent enabled: %s; parent provisioned: %s" % (
                "", fmt_dcs(pf["ENABLED_ids"]), fmt_dcs(pf["PROVISIONED_ids"])))

    header(4, "ZACCOUNT integer columns per account in Accounts4 (own / parent)")
    if a4 is not None and a4.int_cols:
        out("label  " + "  ".join(safe_ident(c) for c in a4.int_cols))
        for a, f, p, pf in rows:
            if a.row is None:
                continue
            out("%-5s  %s" % (a.label, "  ".join(
                "%s/%s" % (safe_int(a.row.get(c)), "-" if p is None else safe_int(p.get(c)))
                for c in a4.int_cols)))

    header(5, "summary: features among accounts in Accounts4 with a store directory")
    live = [(a, f, p, pf) for a, f, p, pf in rows if a.row is not None and a.has_store]
    out("accounts in Accounts4 with store: %d (%s)" % (len(live), ", ".join(a.label for a, _, _, _ in live) or "none"))
    feats = collections.OrderedDict()
    for a, f, p, pf in live:
        vals = {
            "active": safe_int(f["active"]), "visible": safe_int(f["visible"]),
            "mail enabled": yn(f["ENABLED"]), "mail provisioned": yn(f["PROVISIONED"]),
            "has parent": yn(p is not None),
            "parent active": "-" if pf is None else safe_int(pf["active"]),
            "parent visible": "-" if pf is None else safe_int(pf["visible"]),
            "parent mail enabled": "-" if pf is None else yn(pf["ENABLED"]),
            "parent mail provisioned": "-" if pf is None else yn(pf["PROVISIONED"]),
            "enabled dataclasses": fmt_dcs(f["ENABLED_ids"]),
            "provisioned dataclasses": fmt_dcs(f["PROVISIONED_ids"]),
            "parent enabled dataclasses": "-" if pf is None else fmt_dcs(pf["ENABLED_ids"]),
            "parent provisioned dataclasses": "-" if pf is None else fmt_dcs(pf["PROVISIONED_ids"]),
        }
        for c in (a4.int_cols if a4 is not None else []):
            vals["ZACCOUNT." + safe_ident(c)] = safe_int(a.row.get(c))
            vals["parent ZACCOUNT." + safe_ident(c)] = "-" if p is None else safe_int(p.get(c))
        for k, v in vals.items():
            feats.setdefault(k, collections.defaultdict(list))[v].append(a.label)
    split = [(k, d) for k, d in feats.items() if len(d) > 1]
    out("features that are the same for all: %d" % (len(feats) - len(split)))
    out("features that differ (value: accounts):")
    for k, d in split:
        out("  %s: %s" % (k, "; ".join("%s: %s" % (v, ",".join(ls)) for v, ls in sorted(d.items()))))
    if not split:
        out("  none")
    return 0


# --------------------------------------------------------------------------- Selbsttest

# Feste Test-UUIDs, nur fuer den Selbsttest.
T_UUIDS = ["0000000%d-0000-4000-8000-00000000000%d" % (i, i) for i in range(1, 6)]


def build_fixture(base):
    """Baut einen kleinen Mail-Store und ein Accounts4 mit reservierten Domains.

    A1 IMAP, Mail aktiviert, Store.  A2 Kind eines Elternkontos, Mail aktiviert, Store.
    A3 Mail nur provisioniert (abgeschaltet), Store.  A4 nicht in Accounts4, kein Store.
    A5 lokal (Host ohne UUID), kein Store.
    Wie im echten Accounts4 ist ZDATACLASS leer; die Verknuepfungen zeigen auf Entitaet 7, eine
    Unterentitaet, deren Zeilen in der Tabelle ihrer Oberentitaet (ZNAMEDOBJECT) liegen."""
    root = os.path.join(base, "Mail")
    vdir = os.path.join(root, "V10")
    os.makedirs(os.path.join(vdir, "MailData"))
    env = sqlite3.connect(os.path.join(vdir, "MailData", "Envelope Index"))
    env.execute("CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, total_count INTEGER)")
    urls = ["imap://%s/INBOX" % T_UUIDS[0], "ews://%s/Inbox" % T_UUIDS[1], "imap://%s/INBOX" % T_UUIDS[2],
            "imap://%s/Sent" % T_UUIDS[0], "imap://%s/INBOX" % T_UUIDS[3], "local://OnMyMac/Archive"]
    env.executemany("INSERT INTO mailboxes (url, total_count) VALUES (?, 0)", [(u,) for u in urls])
    env.commit()
    env.close()
    for u, n in ((T_UUIDS[0], 3), (T_UUIDS[1], 1), (T_UUIDS[2], 2)):
        d = os.path.join(vdir, u, "INBOX.mbox", "Data", "Messages")
        os.makedirs(d)
        for i in range(n):
            open(os.path.join(d, "%d.emlx" % (i + 1)), "w").close()
        os.makedirs(os.path.join(vdir, u, "INBOX.mbox", "Attachments", "1"))
        open(os.path.join(vdir, u, "INBOX.mbox", "Attachments", "1", "9.emlx"), "w").close()

    acc = os.path.join(base, "Accounts4.sqlite")
    con = sqlite3.connect(acc)
    con.executescript("""
        CREATE TABLE ZACCOUNT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTIVE INTEGER,
            ZAUTHENTICATED INTEGER, ZVISIBLE INTEGER, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER,
            ZIDENTIFIER VARCHAR, ZUSERNAME VARCHAR, ZACCOUNTDESCRIPTION VARCHAR);
        CREATE TABLE ZACCOUNTTYPE (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR);
        CREATE TABLE ZDATACLASS (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR);
        CREATE TABLE ZNAMEDOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR);
        CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
        CREATE TABLE Z_2ENABLEDDATACLASSES (Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER);
        CREATE TABLE Z_2PROVISIONEDDATACLASSES (Z_2PROVISIONEDACCOUNTS INTEGER, Z_7PROVISIONEDDATACLASSES INTEGER);
        INSERT INTO Z_PRIMARYKEY VALUES (2, 'Account', 0, 4), (3, 'AccountType', 0, 3), (4, 'Dataclass', 0, 0),
            (7, 'EnabledDataclass', 8, 3), (8, 'NamedObject', 0, 3);
        INSERT INTO ZACCOUNTTYPE VALUES (1, 'com.apple.account.IMAP'), (2, 'com.apple.account.Exchange'),
            (3, 'com.apple.account.Google');
        INSERT INTO ZNAMEDOBJECT VALUES (1, 7, 'com.apple.Dataclass.Mail'), (2, 7, 'com.apple.Dataclass.Notes'),
            (3, 7, 'x-custom.user@example.com');
    """)
    rows = [
        (1, 2, 1, 1, 1, 1, 1, None, T_UUIDS[0], "user@example.com", "Work"),
        (2, 2, 1, 1, 1, 1, 3, None, "PARENT-NOT-A-MAIL-HOST", "user@example.org", "Parent"),
        (3, 2, 1, 1, 1, 0, 2, 2, T_UUIDS[1], "user@example.org", None),
        (4, 2, 1, 1, 1, 1, 1, None, T_UUIDS[2], "user@example.net", "Off in Mail"),
    ]
    con.executemany("INSERT INTO ZACCOUNT VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.executemany("INSERT INTO Z_2ENABLEDDATACLASSES VALUES (?,?)", [(1, 1), (1, 2), (1, 3), (2, 1), (4, 2)])
    con.executemany("INSERT INTO Z_2PROVISIONEDDATACLASSES VALUES (?,?)",
                    [(1, 1), (1, 2), (2, 1), (3, 1), (4, 1), (4, 2)])
    con.commit()
    con.close()
    return root, acc


def selftest():
    base = tempfile.mkdtemp(prefix="check-mail-enabled-")
    try:
        root, acc = build_fixture(base)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = run(argparse.Namespace(root=root, accounts=acc))
        text = buf.getvalue()
    finally:
        shutil.rmtree(base, ignore_errors=True)
    # Nur die Tabelle aus Abschnitt 3 (Zeilen mit "|"), nicht die aus Abschnitt 4.
    lines = {l.split()[0]: l for l in text.splitlines() if re.match(r"^A\d+ ", l) and "|" in l}
    checks = [
        ("exit code 0", rc == 0),
        ("five accounts", "account hosts: 5; with V<n>/<uuid> directory: 3" in text),
        ("enabled table found", "enabled link table: Z_2ENABLEDDATACLASSES(Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES), rows 5" in text),
        ("entities listed", "2 Account 0, 3 AccountType 0, 4 Dataclass 0, 7 EnabledDataclass 8, 8 NamedObject 0" in text),
        ("entity 7 resolved via super", "  target entity 7 -> table ZNAMEDOBJECT, identifier column ZIDENTIFIER; "
         "'com.apple.Dataclass.Mail' present: yes" in text),
        ("own table missing noted", "  target entity 7 (EnabledDataclass): no table" in text),
        ("A1 dataclasses", "A1    own enabled: Mail, Notes, other x1; own provisioned: Mail, Notes" in text),
        ("A2 parent dataclasses", "      parent enabled: Mail; parent provisioned: Mail" in text),
        ("summary dataclasses", "  enabled dataclasses: Mail, Notes, other x1: A1; Notes: A3; none: A2" in text),
        ("provisioned table found", "provisioned link table: Z_2PROVISIONEDDATACLASSES(" in text),
        ("A1 enabled", re.search(r"^A1 .*\| yes   1      1       yes      yes      3      2 ", lines.get("A1", ""), re.M)),
        ("A1 .emlx without Attachments", re.search(r"yes        3  \|", lines.get("A1", ""))),
        ("A2 parent enabled", re.search(r"\| yes    1      1       yes      yes ", lines.get("A2", ""))),
        ("A3 mail off", re.search(r"\| yes   1      1       no       yes      1      2 ", lines.get("A3", ""))),
        ("A4 not in Accounts4", re.search(r"\| no    -", lines.get("A4", ""))),
        ("summary splits mail enabled", "  mail enabled: no: A2,A3; yes: A1" in text),
        ("summary splits parent", "  has parent: no: A1,A3; yes: A2" in text),
        ("int columns compared", "ZACCOUNT integer columns compared below: ZACTIVE, ZAUTHENTICATED, ZVISIBLE, Z_ENT" in text),
        ("same int column not listed", "\n  ZACCOUNT.ZAUTHENTICATED" not in text),
        ("differing int column listed", "  ZACCOUNT.ZVISIBLE: 0: A2; 1: A1,A3" in text),
        ("no UUID in output", not UUID_ANY.search(text) and text.count("<uuid>") == 1),
        ("no address in output", "@" not in text and "example." not in text),
        ("no temp path in output", base not in text),
    ]
    bad = [n for n, ok in checks if not ok]
    if bad:
        sys.stdout.write(text)
        out("selftest FAILED: %s" % "; ".join(bad))
        return 1
    out("selftest ok (%d checks)" % len(checks))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Check whether Mail is enabled for each Mail account (read-only).")
    ap.add_argument("--root", default=os.path.join(HOME, "Library", "Mail"))
    ap.add_argument("--accounts", default=os.path.join(HOME, "Library", "Accounts", "Accounts4.sqlite"))
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
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
