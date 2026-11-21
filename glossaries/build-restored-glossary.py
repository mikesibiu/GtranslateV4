#!/usr/bin/env python3
"""Rebuild glossaries/ro-en-religious-terms.csv from the original 806-entry glossary
(ro-en-live-2026-05-24-backup.csv), removing or correcting ONLY entries that were measured to
damage real meeting sentences (2026-11-15 review: every entry tested with vs. without the glossary
on 1,226 real meeting rows). Evidence per entry: glossaries/glossary-review-2026-11-15.md.
A glossary forces one fixed English string, so conjugated verbs, function words and words inside
idioms cannot be right as glossary entries; nouns, names and JW terms can."""
import csv, unicodedata, os
HERE = os.path.dirname(os.path.abspath(__file__))
def strip(s): return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').lower()

REMOVE = """trebuie prieteni multe mulți spune văzut lucrarea viața rugăm siguranță faptul înțelegem cuvântul
lumea nimic regele crezi există exista biblic biblice început înseamnă timpul diferite materiale cuvintele părere
anume noastră nostru noastre vedere continui importantă înveți merită plăcut plăcută plăcuți prezent studiul tuturor
vorbești vorbește reușit adevărat adevărații bucura bucură bucuram pregătit punct totdeauna veghe atenție drept gândește
încearcă place spiritul acestei aproape ascultat determinat dreptul Organizația Societatea ajutorul alții creat iubesc
nevoie simți simte binele cauza folosim indiferent întotdeauna învață învăța invatam învățat numit părinților păstrăm
permite răspunde singur studiezi altele analizați atins banii hotărât ideea legile limba locul motiv plină problema
problemele suferă sufera suferim ajută ajute ajutat inima inimă prietenii carte întâmplă schimbă schimbat studia
înțelege alege deveni folosește folosești folosi folosit întreabă întreba promite rămâne rămâi rămână ramai clară clara
cunoaște cunosti lupta Faptele aprobă ascultă asemănător așteaptă caută cinstiți citește citești citiți conduce
conducatori continua continuă conține curaj curată decizia dedici dezvăluie explica explică fizic guverneze iubești
mesajul murim natură observa observă participa perioada persevera predică predica predicam pregăti prețuiește prețuim
privire realiza respectă respecta respectam scris situația sluji susține turnul târziu începe""".split()

FIX = {  # wrong word form / wrong sense / mid-sentence capital → corrected target
    'fidel': 'faithful', 'prevăzător': 'discreet', 'bătrânilor': 'elders', 'batranii': 'elders', 'batrani': 'elders',
    'sfaturi': 'advice', 'întrebări': 'questions', 'cărți': 'books', 'schimbări': 'changes',
    'creștinilor': 'Christians', 'discipolii': 'disciples', 'evenimente': 'events', 'familiei': 'family',
    'loiali': 'loyal', 'medicale': 'medical', 'sărbători': 'holidays', 'sărbătorile': 'holidays',
    'întrunire': 'meeting', 'congregația': 'congregation', 'lecția': 'lesson', 'exemplul': 'example',
    'divertismente': 'entertainment', 'capitolul': 'chapter',
}
ADD = [('turn de veghe', 'Watchtower'), ('sclavul fidel și prevăzător', 'the faithful and discreet slave'),
       ('Faptele apostolilor', 'Acts'),
       # 2026-11-19 row 17: the single-word entry înaintea→before turned "607 înaintea erei noastre"
       # into "607 BEFORE". A longer entry wins over the single word, so add the whole phrase.
       ('înaintea erei noastre', 'B.C.E.'), ('înainte de era noastră', 'B.C.E.'),
       ('înainte erei noastre', 'B.C.E.')]

remove = {strip(x) for x in REMOVE}
fix = {strip(k): v for k, v in FIX.items()}
src = [r for r in csv.reader(open(os.path.join(HERE, 'ro-en-live-2026-05-24-backup.csv'), encoding='utf-8')) if len(r) >= 2][1:]
out, seen, removed, fixed = [], set(), [], []
for a, b in src:
    if (a, b) in seen: continue
    seen.add((a, b))
    k = strip(a)
    if ' ' not in a and k in remove: removed.append((a, b)); continue
    if ' ' not in a and k in fix and b != fix[k]: fixed.append((a, b, fix[k])); b = fix[k]
    out.append((a, b))
have = {a.lower() for a, _ in out}
for a, b in ADD:
    if a.lower() not in have: out.append((a, b))
with open(os.path.join(HERE, 'ro-en-religious-terms.csv'), 'w', encoding='utf-8', newline='') as f:
    csv.writer(f, lineterminator='\n').writerows(out)
print(f'original {len(src)}  kept {len(out) - len(ADD)} (of which corrected {len(fixed)})  removed {len(removed)}  added {len(ADD)}  => {len(out)}')
