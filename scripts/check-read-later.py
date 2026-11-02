#!/usr/bin/python3 -I
# Pruefskript fuer AMM-20: Mail zeigt Mails mit "Erinnern" ab dem Termin wieder im Eingang, auch
# wenn sie in einem anderen Ordner liegen. Der Termin steht in message_global_data.read_later_date.
# Fragen: (1) In welcher Einheit steht der Termin, und was bedeutet ein Termin in der Zukunft?
# (2) Welche anderen Spalten aendern sich (Mailbox, Flags, display_date, Aktionen, Labels)?
# (3) Wie haengen die faelligen Erinnerungen mit dem Eingang ihres Kontos zusammen, und zaehlt
# Mail sie in mailboxes.total_count/unread_count des Eingangs mit?
# Martin startet es selbst aus einem Terminal mit Full Disk Access:
#   /usr/bin/python3 -I scripts/check-read-later.py
#
# Versuch fuer Frage (1) und (2): Skript laufen lassen, in Mail bei einer Mail im Eingang von A12
# "Erinnern > Morgen" waehlen, Mail beenden, Skript erneut starten und beide Ausgaben vergleichen.
# Abschnitt 3 zeigt je Erinnerung eine Zeile, Abschnitt 4 die Zaehler je Eingang.
#
# Datenschutz: Die Ausgabe enthaelt nur Zaehler, Zeitabstaende in festen Stufen, Ja/Nein-Werte,
# Bitnummern, Spaltennamen und Ordnerarten aus einer festen Liste (inbox, archive, sent, ...).
# Keine Betreffs, Absender, Adressen, Mailboxnamen, ROWIDs oder UUIDs (Konten heissen A1, A2, ...
# in der Reihenfolge ihrer kleinsten Mailbox-ROWID, wie in check-categories-attachments.py;
# Erinnerungen heissen R1, R2, ... nach Termin). Jede Zeile laeuft durch out(); dort werden
# $HOME, Adressen und UUIDs geschwaerzt. Alles ist lesend (SQLite per URI mode=ro, nie
# immutable). Es wird nichts geschrieben, auch kein Bericht.
#
# Optionen (NUR FUER SELBSTTESTS mit synthetischen Daten):
#   --root DIR   Standard: ~/Library/Mail
#   --selftest   baut eine synthetische Datenbank in einem Temp-Ordner und prueft die Ausgabe
import argparse
import collections
import contextlib
import io
import os
import platform
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.parse

HOME = os.path.expanduser("~")
UUID_PAT = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
UUID_ANY = re.compile(UUID_PAT)
EMAIL_RE = re.compile(r"[^\s@<>\"']+@[^\s@<>\"']+")
MAC_EPOCH = 978307200  # 2001-01-01 in Unix-Sekunden
PLAUSIBLE = (1420070400, 2051222400)  # 2015-01-01 bis 2035-01-01

# Ordnerart aus dem letzten Pfadsegment; nur diese Arten werden genannt, alles andere heisst "other".
KINDS = {
    "INBOX": "inbox", "POSTEINGANG": "inbox",
    "ARCHIVE": "archive", "ARCHIV": "archive", "ALL MAIL": "archive", "ALLE NACHRICHTEN": "archive",
    "SENT": "sent", "SENT MESSAGES": "sent", "SENT ITEMS": "sent", "SENT MAIL": "sent",
    "GESENDET": "sent", "GESENDETE OBJEKTE": "sent",
    "DRAFTS": "drafts", "ENTWUERFE": "drafts", "ENTWÜRFE": "drafts",
    "TRASH": "trash", "DELETED MESSAGES": "trash", "DELETED ITEMS": "trash", "PAPIERKORB": "trash",
    "JUNK": "junk", "SPAM": "junk", "WERBUNG": "junk",
}


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
    return "yes" if v else "no"


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


def counter_line(c):
    return ", ".join("%s=%d" % (k, c[k]) for k in sorted(c)) if c else "-"


def epoch_of(v):
    """Einheit des Termins: unix, mac (Sekunden seit 2001) oder unknown."""
    if not isinstance(v, (int, float)):
        return "non-number"
    if PLAUSIBLE[0] <= v <= PLAUSIBLE[1]:
        return "unix"
    if PLAUSIBLE[0] <= v + MAC_EPOCH <= PLAUSIBLE[1]:
        return "mac"
    return "unknown"


def rel(ts, now):
    """Abstand zu jetzt in festen Stufen, ohne Datum."""
    if not isinstance(ts, (int, float)):
        return "-"
    d = ts - now
    a = abs(d)
    for limit, name in ((3600, "<1h"), (86400, "1h-1d"), (7 * 86400, "1-7d"),
                        (30 * 86400, "7-30d"), (365 * 86400, "30-365d")):
        if a < limit:
            break
    else:
        name = ">1y"
    return ("in " if d > 0 else "ago ") + name


def order(a, b):
    """Vergleich zweier Zeitstempel als Wort, ohne Werte."""
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return "-"
    return "equal" if a == b else ("before" if a < b else "after")


# --------------------------------------------------------------------------- Konten und Mailboxen

class Mailbox:
    def __init__(self, rowid, url):
        p = urllib.parse.urlsplit(url or "")
        self.rowid = rowid
        self.account = p.netloc
        segs = [urllib.parse.unquote(s) for s in p.path.split("/") if s]
        self.is_inbox = len(segs) == 1 and segs[0].upper() == "INBOX"
        kind = KINDS.get(segs[-1].upper(), "other") if segs else "other"
        if kind == "inbox" and not self.is_inbox:
            kind = "other"
        self.kind = kind
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


def label_key(lab):
    return int(lab[1:]) if lab[1:].isdigit() else 0


# --------------------------------------------------------------------------- Lauf

def run(args):
    ver = find_version_dir(args.root)
    if not ver:
        out("no V<n> directory in ~/Library/Mail")
        return 1
    idx = os.path.join(ver[1], "MailData", "Envelope Index")
    now = args.now if args.now is not None else int(time.time())
    out("Read-later (Remind Me) check (AMM-20)")
    out("macOS %s, store version dir: V%d" % (platform.mac_ver()[0] or "?", ver[0]))
    con = open_ro(idx)
    tabs = tables(con)
    boxes, labels = load_mailboxes(con)
    inbox_of = {}
    for b in boxes.values():
        if b.is_inbox and b.account not in inbox_of:
            inbox_of[b.account] = b.rowid
    out("accounts: %d, mailboxes: %d, inboxes: %d" % (len(labels), len(boxes), len(inbox_of)))

    header(1, "Schema")
    mgd = columns(con, "message_global_data") if "message_global_data" in tabs else set()
    msg = columns(con, "messages")
    mbc = columns(con, "mailboxes")
    for col in ("read_later_date", "send_later_date", "follow_up_start_date", "follow_up_end_date", "due_by"):
        out("message_global_data.%s: %s" % (col, yn(col in mgd)))
    for col in ("display_date", "date_last_viewed", "remote_mailbox", "flags"):
        out("messages.%s: %s" % (col, yn(col in msg)))
    out("mailboxes.unread_count_adjusted_for_duplicates: %s" % yn("unread_count_adjusted_for_duplicates" in mbc))
    out("tables labels / action_messages / server_messages: %s / %s / %s" % (
        yn("labels" in tabs), yn("action_messages" in tabs), yn("server_messages" in tabs)))
    if "read_later_date" not in mgd:
        out("read_later_date missing: nothing to check")
        return 0

    header(2, "Values in message_global_data (all rows)")
    for col in ("read_later_date", "send_later_date", "follow_up_start_date", "follow_up_end_date", "due_by"):
        if col not in mgd:
            continue
        vals = [r[0] for r in con.execute("SELECT %s FROM message_global_data WHERE %s IS NOT NULL" % (col, col))]
        out("%s: %d non-null, unit %s, due %d, future %d, zero %d" % (
            col, len(vals), counter_line(collections.Counter(epoch_of(v) for v in vals if v)),
            sum(1 for v in vals if isinstance(v, (int, float)) and 0 < v <= now),
            sum(1 for v in vals if isinstance(v, (int, float)) and v > now),
            sum(1 for v in vals if v == 0)))

    # Je Erinnerung alle Kopien (auch geloeschte).
    sel_display = "m.display_date" if "display_date" in msg else "NULL"
    sel_viewed = "m.date_last_viewed" if "date_last_viewed" in msg else "NULL"
    sel_remote = "m.remote_mailbox" if "remote_mailbox" in msg else "NULL"
    rows = con.execute("""
        SELECT g.ROWID, g.read_later_date, m.ROWID, m.mailbox, m.deleted, m.read, m.flagged, m.flags,
               m.date_received, %s, %s, %s
        FROM message_global_data g LEFT JOIN messages m ON m.global_message_id = g.ROWID
        WHERE g.read_later_date IS NOT NULL AND g.read_later_date != 0
        ORDER BY g.read_later_date, g.ROWID, m.ROWID""" % (sel_display, sel_viewed, sel_remote)).fetchall()
    groups = collections.OrderedDict()
    for r in rows:
        groups.setdefault(r[0], []).append(r)

    labels_by_msg = collections.defaultdict(set)
    if "labels" in tabs:
        ids = [r[2] for r in rows if r[2] is not None]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for mid, mb in con.execute("SELECT message_id, mailbox_id FROM labels WHERE message_id IN (%s)" %
                                       ",".join("?" * len(chunk)), chunk):
                labels_by_msg[mid].add(mb)
    actions_by_msg = collections.Counter()
    if "action_messages" in tabs:
        ids = [r[2] for r in rows if r[2] is not None]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for (mid,) in con.execute("SELECT message FROM action_messages WHERE message IN (%s)" %
                                      ",".join("?" * len(chunk)), chunk):
                actions_by_msg[mid] += 1

    header(3, "Each reminder (R = distinct mail with read_later_date, ordered by date)")
    out("Per copy: account, folder kind, in that account's inbox, deleted, read, flagged, flag bits,")
    out("remote_mailbox (same/inbox/other/NULL), Gmail-style label on the inbox, pending local actions,")
    out("display_date vs reminder, display_date vs date_received, last viewed vs reminder.")
    due_outside = collections.defaultdict(lambda: collections.Counter())
    bits_seen = collections.Counter()
    for n, (gid, copies) in enumerate(groups.items(), 1):
        when = copies[0][1]
        state = "due" if when <= now else "future"
        out("R%d: %s, %s, unit %s, copies %d" % (n, state, rel(when, now), epoch_of(when),
                                                 sum(1 for c in copies if c[2] is not None)))
        live_accounts = set()
        for _, _, mid, mb, deleted, read, flagged, flags, recv, disp, viewed, remote in copies:
            if mid is None:
                out("  no copy in messages")
                continue
            b = boxes.get(mb)
            acc = b.account if b else None
            lab = b.label if b else "?"
            kind = b.kind if b else "unknown"
            bits = [i for i in range(64) if isinstance(flags, int) and flags >> i & 1]
            bits_seen.update(bits)
            if remote is None:
                rm = "NULL"
            elif remote == mb:
                rm = "same"
            elif remote == inbox_of.get(acc):
                rm = "inbox"
            else:
                rm = "other"
            on_inbox = inbox_of.get(acc) in labels_by_msg.get(mid, set())
            out("  %s %-7s in-inbox=%s deleted=%s read=%s flagged=%s bits=%s remote=%s inbox-label=%s "
                "actions=%d display-vs-reminder=%s display-vs-received=%s viewed-vs-reminder=%s" % (
                    lab, kind, yn(b is not None and b.is_inbox), yn(deleted), yn(read), yn(flagged),
                    ",".join(map(str, bits)) or "-", rm, yn(on_inbox), actions_by_msg.get(mid, 0),
                    order(disp, when), order(disp, recv), order(viewed, when) if viewed else "never"))
            if not deleted and b is not None:
                live_accounts.add(acc)
                if state == "due" and not b.is_inbox:
                    due_outside[acc]["all"] += 1
                    if not read:
                        due_outside[acc]["unread"] += 1
        if len(live_accounts) > 1:
            out("  live copies in %d accounts" % len(live_accounts))
    if not groups:
        out("no reminders")

    header(4, "Inbox per account: rows vs Mail's counters vs due reminders outside the inbox")
    out("rows = non-deleted rows in the inbox; total/unread = mailboxes.total_count/unread_count;")
    out("due-outside = non-deleted copies of due reminders in other folders of the same account;")
    out("future-inside = non-deleted inbox rows whose reminder is still in the future.")
    adj = "unread_count_adjusted_for_duplicates" in mbc
    future_inside = collections.Counter()
    for gid, copies in groups.items():
        if copies[0][1] > now:
            for c in copies:
                b = boxes.get(c[3])
                if c[2] is not None and not c[4] and b is not None and b.is_inbox:
                    future_inside[b.account] += 1
    for acc, rid in sorted(inbox_of.items(), key=lambda kv: label_key(labels.get(kv[0], "?"))):
        n_rows, n_unread = con.execute(
            "SELECT count(*), coalesce(sum(read = 0), 0) FROM messages WHERE mailbox = ? AND deleted = 0",
            (rid,)).fetchone()
        tot, unr, unr_adj = con.execute(
            "SELECT total_count, unread_count, %s FROM mailboxes WHERE ROWID = ?" % (
                "unread_count_adjusted_for_duplicates" if adj else "NULL"), (rid,)).fetchone()
        d = due_outside.get(acc, collections.Counter())
        out("%-4s rows %d (unread %d) | total %s unread %s%s | due-outside %d (unread %d) | rows+due %d | "
            "future-inside %d" % (
                labels.get(acc, "?"), n_rows, n_unread, tot, unr,
                (" unread-adj %s" % unr_adj) if adj else "", d["all"], d["unread"], n_rows + d["all"],
                future_inside.get(acc, 0)))
    for acc in sorted(set(due_outside) - set(inbox_of), key=lambda a: label_key(labels.get(a, "?"))):
        out("%s has due reminders outside but no inbox: %d" % (labels.get(acc, "?"), due_outside[acc]["all"]))

    header(5, "messages.flags bits on reminder copies vs all non-deleted messages")
    total = con.execute("SELECT count(*) FROM messages WHERE deleted = 0").fetchone()[0]
    for bit in sorted(bits_seen):
        n = con.execute("SELECT count(*) FROM messages WHERE deleted = 0 AND (flags >> ?) & 1",
                        (bit,)).fetchone()[0]
        out("bit %2d: reminder copies %d, all messages %d of %d" % (bit, bits_seen[bit], n, total))
    if not bits_seen:
        out("no flag bits on reminder copies")
    out()
    out("done")
    return 0


# --------------------------------------------------------------------------- Selbsttest

def build_fixture(base):
    root = os.path.join(base, "Mail")
    os.makedirs(os.path.join(root, "V10", "MailData"))
    con = sqlite3.connect(os.path.join(root, "V10", "MailData", "Envelope Index"))
    con.executescript("""
        CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, total_count INTEGER, unread_count INTEGER,
                                unread_count_adjusted_for_duplicates INTEGER);
        CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, global_message_id INTEGER, mailbox INTEGER,
                               remote_mailbox INTEGER, flags INTEGER DEFAULT 0, read INTEGER DEFAULT 0,
                               flagged INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, date_received INTEGER,
                               display_date INTEGER, date_last_viewed INTEGER);
        CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, read_later_date INTEGER,
                                          send_later_date INTEGER, follow_up_start_date INTEGER,
                                          follow_up_end_date INTEGER);
        CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER, PRIMARY KEY(message_id, mailbox_id));
        CREATE TABLE action_messages (ROWID INTEGER PRIMARY KEY, message INTEGER);
    """)
    a = "imap://11111111-2222-3333-4444-555555555555"
    b = "imap://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    con.executemany("INSERT INTO mailboxes VALUES (?,?,?,?,?)", [
        (1, a + "/INBOX", 3, 1, 1), (2, a + "/Archive", 5, 0, 0), (3, b + "/INBOX", 1, 0, 0),
        (4, b + "/Sent%20Messages", 0, 0, 0), (5, a + "/Projekte%20test", 0, 0, 0)])
    now = 1800000000
    con.executemany("INSERT INTO message_global_data VALUES (?,?,?,?,?)", [
        (1, now - 7200, None, None, None),    # faellig, im Archiv von A1
        (2, now - 200000, None, None, None),  # faellig, in einem anderen Ordner von A1
        (3, now + 86400 * 3, None, None, None),  # Zukunft, im Eingang von A1
        (4, now - 50, None, None, None),      # faellig, geloeschte Kopie in A2
        (5, None, now + 60, None, None),
        (6, None, None, None, None)])
    con.executemany("INSERT INTO messages (ROWID, global_message_id, mailbox, remote_mailbox, flags, read, flagged, "
                    "deleted, date_received, display_date, date_last_viewed) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        (10, 1, 2, 2, 1 << 4, 0, 0, 0, now - 900000, now - 7200, None),
        (11, 2, 5, None, 0, 1, 1, 0, now - 900000, now - 900000, now - 100),
        (12, 3, 1, 1, 0, 0, 0, 0, now - 1000, now - 1000, None),
        (13, 4, 4, 4, 0, 0, 0, 1, now - 1000, now - 1000, None),
        (14, 6, 1, 1, 1 << 4, 1, 0, 0, now - 1000, now - 1000, None),
        (15, 6, 1, 1, 0, 0, 0, 0, now - 1000, now - 1000, None),
        (16, 6, 3, 3, 0, 0, 0, 0, now - 1000, now - 1000, None)])
    con.execute("INSERT INTO labels VALUES (10, 1)")
    con.execute("INSERT INTO action_messages VALUES (1, 11)")
    con.commit()
    con.close()
    return root, now


def selftest():
    base = tempfile.mkdtemp(prefix="check-read-later-")
    try:
        root, now = build_fixture(base)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = run(argparse.Namespace(root=root, now=now))
        text = buf.getvalue()
    finally:
        shutil.rmtree(base, ignore_errors=True)
    checks = [
        ("exit code 0", rc == 0),
        ("two accounts", "accounts: 2, mailboxes: 5, inboxes: 2" in text),
        ("read_later counted", "read_later_date: 4 non-null, unit unix=4, due 3, future 1, zero 0" in text),
        ("send_later counted", "send_later_date: 1 non-null, unit unix=1, due 0, future 1, zero 0" in text),
        ("R1 oldest due", "R1: due, ago 1-7d, unit unix, copies 1" in text),
        ("R1 other folder", "  A1 other   in-inbox=no deleted=no read=yes flagged=yes bits=- remote=NULL "
         "inbox-label=no actions=1 display-vs-reminder=before display-vs-received=equal "
         "viewed-vs-reminder=after" in text),
        ("R2 archive with inbox label", "  A1 archive in-inbox=no deleted=no read=no flagged=no bits=4 remote=same "
         "inbox-label=yes actions=0 display-vs-reminder=equal display-vs-received=after "
         "viewed-vs-reminder=never" in text),
        ("R3 deleted sent", "R3: due, ago <1h, unit unix, copies 1" in text and "  A2 sent    in-inbox=no deleted=yes" in text),
        ("R4 future", "R4: future, in 1-7d, unit unix, copies 1" in text and "  A1 inbox   in-inbox=yes" in text),
        ("A1 inbox line", "A1   rows 3 (unread 2) | total 3 unread 1 unread-adj 1 | due-outside 2 (unread 1) | "
         "rows+due 5 | future-inside 1" in text),
        ("A2 inbox line", "A2   rows 1 (unread 1) | total 1 unread 0 unread-adj 0 | due-outside 0 (unread 0) | "
         "rows+due 1 | future-inside 0" in text),
        ("flag bit compared", "bit  4: reminder copies 1, all messages 2 of 6" in text),
        ("done", text.rstrip().endswith("done")),
        ("no UUID in output", not UUID_ANY.search(text)),
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
    ap = argparse.ArgumentParser(description="Count Mail's Remind Me data (read-only).")
    ap.add_argument("--root", default=os.path.join(HOME, "Library", "Mail"))
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    args.now = None
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
