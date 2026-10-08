import json
from fractions import Fraction
from pathlib import Path
p=Path(__file__).parent
cases=json.loads((p/'qoe-fixtures.json').read_text())
for c in cases:
 w=sum(x['watch_ms'] for x in c['sessions']);s=sum(x['non_seek_stall_ms'] for x in c['sessions']);k=sum(x['seek_stall_ms'] for x in c['sessions'])
 r=Fraction(s,w+s) if w+s else None
 inc=Fraction(s+k,w+s+k) if w+s+k else None
 gate='INVALID' if r is None or w<=0 else 'PASS' if 100*s<w+s else 'FAIL'
 assert gate==c['gate'],c
 assert r==(Fraction(c['non_seek_fraction']) if c['non_seek_fraction'] else None)
 assert inc==(Fraction(c['inclusive_fraction']) if c['inclusive_fraction'] else None)
 print(json.dumps({'name':c['name'],'watch_ms':w,'non_seek_stall_ms':s,'seek_stall_ms':k,'ratio':float(r) if r is not None else None,'ratio_incl_seek':float(inc) if inc is not None else None,'gate':gate}))
print('Numerical oracle: 9/9 PASS. Independent expected arithmetic, not proof of corrected LT2 implementation.')
