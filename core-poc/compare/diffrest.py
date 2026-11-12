import json,difflib
log=json.load(open('log_messages.json')); ours=json.load(open('ours.json'))
n=lambda s:s.replace('\r\n','\n').strip()
oset={n(m['content']) for m in ours}
used=set()
print('== 우리 출력 중 로그에 똑같은 게 없는 것')
for i,m in enumerate(ours):
    if n(m['content']) not in {n(x['content']) for x in log}:
        c=n(m['content'])
        best=max(range(len(log)),key=lambda j:difflib.SequenceMatcher(None,c[:3000],n(log[j]['content'])[:3000]).ratio())
        r=difflib.SequenceMatcher(None,c[:3000],n(log[best]['content'])[:3000]).ratio()
        print(f"ours#{i} [{m['role']}] len={len(c)} | 가장 비슷한 로그 #{best} (유사도 {r:.2f}) | {c[:60]!r}")
        if r>0.5:
            a=n(log[best]['content']).splitlines(); b=c.splitlines()
            d=[l for l in difflib.unified_diff(a,b,'log','ours',n=0,lineterm='') if not l.startswith('@@')]
            print('   차이(앞부분):'); [print('    ',l[:140]) for l in d[2:14]]
