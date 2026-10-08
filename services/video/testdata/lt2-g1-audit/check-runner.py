import os,subprocess,json,shutil,shlex
from pathlib import Path
p=Path(__file__).parent;fake=p/'fake-bin';fake.mkdir(exist_ok=True)
scripts={
'docker':'''#!/usr/bin/env bash
printf '%s\n' "docker $*" >> "$PROBE_LOG"
if [[ "$1" == run && "$*" == *hls-viewers.js* ]]; then exit "${PROBE_HLS:-0}"; fi
if [[ "$1" == run && "$*" == *api-mix.js* ]]; then exit "${PROBE_API:-0}"; fi
exit 0
''',
'node':'''#!/usr/bin/env bash
printf '%s\n' "node $*" >> "$PROBE_LOG"
exit 0
''',
'curl':'''#!/usr/bin/env bash
exit 0
''',
'sleep':'''#!/usr/bin/env bash
exec >/dev/null 2>&1
exec /usr/bin/sleep "$@"
''',
}
for name,body in scripts.items():
 (fake/name).write_text(body,encoding='utf8',newline='\n')
 (fake/name).chmod(0o755)
bash=os.environ.get('PROBE_BASH') or (str(Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Git/bin/bash.exe') if os.name=='nt' else shutil.which('bash'))
assert bash and Path(bash).is_file(), 'bash required (set PROBE_BASH for a custom Git Bash path)'
def bash_path(path):
 if os.name=='nt':
  return subprocess.check_output([bash,'-c','cygpath -u -- "$1"','probe',str(path)],text=True).strip()
 return str(path)
for case,hls,api in [('HLS nonzero API zero',99,0),('HLS zero API nonzero',0,99),('aggregate FAIL artifact but both process exits zero',0,0)]:
 log=p/('runner-'+str(hls)+'-'+str(api)+'.calls');log.write_text('')
 (p/'qoe-gate.json').write_text('{"gate":"FAIL","rebuffer_ratio":0.02}')
 env=dict(os.environ,PATH=str(fake)+os.pathsep+os.environ['PATH'],TARGET_URL='http://127.0.0.1:17878',ALLOW_OUTSIDE_WINDOW='true',LOADTEST_USER_PASSWORD='',LT2_INVITE_CODE='',LEGACY_SITES='',PROBE_HLS=str(hls),PROBE_API=str(api),PROBE_LOG=bash_path(log),QOE_GATE_FILE=bash_path(p/'qoe-gate.json'))
 # bash prepends its own tool paths; explicitly prepend only our no-op CLI adapters.
 # Exported functions take precedence even if the target prepends /tmp/node/bin.
 script='export PATH='+shlex.quote(bash_path(fake))+':"$PATH"; '
 for name in ['docker','node','curl','sleep']:
  script+=name+'(){ '+shlex.quote(bash_path(fake/name))+' "$@"; }; export -f '+name+'; '
 script+='bash '+shlex.quote(bash_path(p/'lt2-run.sh'))
 r=subprocess.run([bash,'-c',script],env=env,capture_output=True,timeout=15)
 (p/('runner-'+str(hls)+'-'+str(api)+'.log')).write_bytes(r.stdout+r.stderr)
 assert r.returncode==(0 if not hls and not api else 1),(case,r.returncode,r.stderr)
 print(json.dumps({'case':case,'actual_exit':r.returncode,'expected_final_gate_exit':1,'commands':log.read_text().splitlines()}))
print('Actual runner status checks: 3/3 observations confirmed; aggregate artifact is ignored.')
