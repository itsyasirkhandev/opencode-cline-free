#!/usr/bin/env python3
"""Drive a disposable real OpenCode V2 server; never import plugin internals."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

RECOMMENDED = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
SECRET_KEYS = {'access', 'refresh', 'token', 'password', 'authorization', 'apikey', 'api_key', 'providerstate', 'key', 'secret', 'credential', 'credentials'}


def redact(value):
    if isinstance(value, dict):
        return {k: '[REDACTED]' if k.lower() in SECRET_KEYS else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'workos:[^\s"\\]+|Bearer\s+[^\s"\\]+|eyJ[\w-]+\.[\w-]+\.[\w-]+', '[REDACTED]', value)
        return re.sub(r'server password \S+', 'server password [REDACTED]', value)
    return value


def write(path, data):
    path.write_text(json.dumps(redact(data), indent=2) + '\n')


def identity(pid):
    # Linux process start time prevents killing a recycled PID.
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except FileNotFoundError:
        return None


class Run:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.runtime = self.root / 'runtime'
        self.evidence = self.root / 'evidence'
        self.manifest = self.root / 'manifest.json'

    def load(self):
        return json.loads(self.manifest.read_text())

    def record(self, name, data):
        write(self.evidence / f'{name}.json', data)

    def request(self, method, path, body=None):
        state = self.load()
        if identity(state['pid']) != state['identity']:
            raise RuntimeError('Owned host is not alive; do not drive a replacement process')
        log = (self.runtime / 'server.log').read_text()
        match = re.search(r'server password (\S+)', log)
        if not match:
            raise RuntimeError('Host has not emitted its private API password')
        credential = base64.b64encode(('opencode:' + match[1]).encode()).decode()
        request = urllib.request.Request(state['url'] + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Basic ' + credential, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    def discover(self):
        results = {}
        for endpoint in ['plugin', 'provider', 'integration', 'model']:
            payload = self.request('GET', '/api/' + endpoint)
            rows = payload['data']
            selected = [row for row in rows if row.get('providerID' if endpoint == 'model' else 'id') == 'cline-free']
            results[endpoint] = selected
        plugin = results['plugin']
        if len(plugin) != 1 or plugin[0]['state']['status'] != 'active':
            raise RuntimeError('cline-free plugin is not active')
        if not results['provider'] or not results['model']:
            raise RuntimeError('Provider or model registration is not ready')
        integration = results['integration']
        if not integration or len(integration[0]['methods']) != 3:
            raise RuntimeError('Expected the three plugin login methods')
        # Restrict evidence to this plugin, not unrelated provider configuration.
        self.record('discovery', {'entryPoint': 'OpenCode V2 public API', **results})
        return results

    def start(self, executable, port):
        repo = Path(__file__).resolve().parents[4]
        if self.root == repo or repo in self.root.parents:
            raise RuntimeError('Run directory must be outside the repository')
        if not 1024 <= port <= 65535:
            raise RuntimeError('Use an unprivileged loopback port from 1024 to 65535')
        if self.root.exists():
            raise RuntimeError('Run path already exists; use a fresh path (evidence is never overwritten)')
        binary = shutil.which(executable)
        if not binary:
            raise RuntimeError('OpenCode executable not found')
        binary = str(Path(binary).resolve())
        version = subprocess.check_output([binary, '--version'], text=True).strip()
        if not re.search(r'\bv2\.', version):
            raise RuntimeError('Requires OpenCode V2; found ' + version)
        repo = Path(__file__).resolve().parents[4]
        if not (repo / 'src/v2.ts').is_file():
            raise RuntimeError('Run this helper from its repository-local skill location')
        self.runtime.mkdir(parents=True, mode=0o700)
        self.root.chmod(0o700)
        self.evidence.mkdir()
        for name in ['home', 'config/opencode', 'data', 'cache', 'state', 'project']:
            (self.runtime / name).mkdir(parents=True)
        (self.runtime / 'config/opencode/opencode.json').write_text(json.dumps({'plugins': [str(repo)]}))
        # Allowlist: no inherited Cline, other provider keys, host config or CLI login.
        names = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
                 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
        env = {key: os.environ[key] for key in names if key in os.environ}
        env.update(HOME=str(self.runtime / 'home'), XDG_CONFIG_HOME=str(self.runtime / 'config'),
                   XDG_DATA_HOME=str(self.runtime / 'data'), XDG_CACHE_HOME=str(self.runtime / 'cache'),
                   XDG_STATE_HOME=str(self.runtime / 'state'),
                   CLINE_FREE_ACCOUNTS_FILE=str(self.runtime / 'accounts.json'),
                   CLINE_FREE_MODELS_FILE=str(self.runtime / 'models.json'))
        command = [binary, 'serve', '--hostname', '127.0.0.1', '--port', str(port), '--print-logs']
        with (self.runtime / 'server.log').open('w') as log:
            child = subprocess.Popen(command, cwd=self.runtime / 'project', env=env,
                                     stdout=log, stderr=log, start_new_session=True)
        state = {'pid': child.pid, 'identity': identity(child.pid), 'url': f'http://127.0.0.1:{port}',
                 'binary': binary, 'version': version, 'repo': str(repo), 'command': command,
                 'revision': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()}
        self.manifest.write_text(json.dumps(state, indent=2))
        self.record('launch', state)
        try:
            deadline = time.monotonic() + 120
            last_error = ''
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError('OpenCode exited during startup; see redacted server log')
                try:
                    self.doctor()
                    print('READY: plugin, provider, models and login methods registered')
                    return
                except (RuntimeError, OSError, ValueError, KeyError) as error:
                    last_error = str(error)
                    time.sleep(1)
            raise RuntimeError('Usable readiness timed out: ' + last_error)
        except BaseException:
            self.cleanup()
            raise

    def doctor(self):
        state = self.load()
        if identity(state['pid']) != state['identity']:
            raise RuntimeError('Owned PID is no longer alive')
        version = subprocess.check_output([state['binary'], '--version'], text=True).strip()
        if version != state['version']:
            raise RuntimeError('Host executable changed since launch')
        data = self.discover()
        plugin_path = data['plugin'][0]['source'].get('path', '')
        if Path(plugin_path).resolve() != Path(state['repo'], 'index.ts').resolve():
            raise RuntimeError('Host loaded a different plugin checkout')
        self.record('doctor', {'result': 'pass', 'pid': state['pid'], 'version': version,
                              'pluginPath': plugin_path, 'modelCount': len(data['model'])})

    def login_start(self):
        self.doctor()
        attempt = self.request('POST', '/api/integration/cline-free/connect/oauth', {'methodID': 'device'})['data']
        # Device URL/code are transient: do not put them in persistent evidence.
        (self.runtime / 'attempt.json').write_text(json.dumps(attempt))
        self.record('login-start', {'entryPoint': 'integration.oauth.connect', 'methodID': 'device',
                                    'result': 'pending user authorization'})
        print(json.dumps({k: attempt[k] for k in ['url', 'instructions']}, indent=2))

    def login_status(self):
        attempt = json.loads((self.runtime / 'attempt.json').read_text())
        status = self.request('GET', '/api/integration/cline-free/connect/oauth/' + attempt['attemptID'])['data']
        self.record('login-status', status)
        print(json.dumps(redact(status)))
        if status['status'] == 'complete':
            self.discover()
            self.pool_summary()

    def pool_summary(self):
        path = self.runtime / 'accounts.json'
        pool = json.loads(path.read_text()) if path.exists() else {}
        accounts = pool.get('accounts', [])
        # Explicit allowlist; never serialize raw pool credentials.
        self.record('pool-summary', {'fileExists': path.exists(), 'accounts': [
            {k: account[k] for k in ['id', 'label', 'source', 'needsRelogin', 'limits'] if k in account}
            for account in accounts]})

    def chat(self, model, variant):
        self.doctor()
        # Fresh live allowlist: a dated fallback or a provider name is not proof of free status.
        with urllib.request.urlopen(RECOMMENDED, timeout=30) as response:
            payload = json.load(response)
        free = {entry['id'] for entry in payload['free']}
        self.record('live-free-list', {'endpoint': RECOMMENDED, 'free': sorted(free), 'checkedAt': time.time()})
        if model not in free:
            raise RuntimeError('Refusing a model absent from the current live free array')
        models = self.discover()['model']
        selected = next((entry for entry in models if entry['id'] == model), None)
        if selected is None or '(paid)' in selected['name'].lower():
            raise RuntimeError('Model is unavailable or marked paid')
        ref = {'id': model, 'providerID': 'cline-free'}
        if variant:
            if variant not in {entry['id'] for entry in selected.get('variants', [])}:
                raise RuntimeError('Variant is not registered for this model')
            ref['variant'] = variant
        integration = self.request('GET', '/api/integration/cline-free')['data']
        if not integration.get('connections'):
            raise RuntimeError('No authorized disposable Cline connection; run login-start first')
        session = self.request('POST', '/api/session', {'title': 'Cline plugin verification', 'model': ref,
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'deny'}]})['data']
        sid = session['id']
        prompt = 'Reply with exactly VERIFY_CLINE_FREE_OK. Do not call tools or modify files.'
        self.record('chat-action', {'entryPoint': 'session.create + session.prompt', 'sessionID': sid,
                                    'model': ref, 'prompt': prompt})
        try:
            self.request('POST', f'/api/session/{sid}/prompt', {'text': prompt})
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                messages = self.request('GET', f'/api/session/{sid}/message')['data']
                idle = [m for m in messages if m['type'] == 'idle']
                if idle:
                    self.record('chat-messages', messages)
                    self.record('chat-session', self.request('GET', f'/api/session/{sid}'))
                    self.pool_summary()
                    assistants = [m for m in messages if m['type'] == 'assistant']
                    if any(m.get('error') for m in assistants) or idle[-1]['outcome'] != 'succeeded':
                        raise RuntimeError('Chat failed; inspect redacted chat evidence')
                    answer = ''.join(c.get('text', '') for m in assistants for c in m['content'] if c['type'] == 'text')
                    if answer.strip() != 'VERIFY_CLINE_FREE_OK':
                        raise RuntimeError('Chat completed but did not produce the requested marker')
                    print('PASS: real free-model turn completed with expected marker')
                    return
                time.sleep(2)
            raise RuntimeError('Chat timed out (not verified)')
        finally:
            try:
                self.request('POST', f'/api/session/{sid}/interrupt', {})
            except (OSError, RuntimeError):
                pass  # Cleanup remains required if the host itself became unavailable.

    def cleanup(self):
        state = self.load()
        alive = identity(state['pid'])
        if alive is not None and alive != state['identity']:
            raise RuntimeError('PID was reused; refusing to signal or delete runtime')
        if alive is not None:
            os.killpg(state['pid'], signal.SIGTERM)
            for _ in range(50):
                if identity(state['pid']) is None:
                    break
                # A reaped-by-parent zombie cannot perform writes.
                stat = Path(f"/proc/{state['pid']}/stat")
                if stat.exists() and stat.read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                    break
                time.sleep(.1)
            else:
                os.killpg(state['pid'], signal.SIGKILL)
        log = self.runtime / 'server.log'
        if log.exists():
            (self.evidence / 'server.redacted.log').write_text(redact(log.read_text()))
        shutil.rmtree(self.runtime, ignore_errors=True)
        self.record('cleanup', {'result': 'pass', 'runtimeRemoved': not self.runtime.exists(),
                                'evidencePreserved': sorted(p.name for p in self.evidence.iterdir())})
        print('CLEANED: owned host stopped; private runtime deleted; evidence preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, help='Fresh absolute directory, outside the checkout')
    commands = parser.add_subparsers(dest='command', required=True)
    start = commands.add_parser('start')
    start.add_argument('--opencode', default='opencode')
    start.add_argument('--port', type=int, required=True)
    for command in ['doctor', 'discover', 'login-start', 'login-status', 'pool-summary', 'cleanup']:
        commands.add_parser(command)
    chat = commands.add_parser('chat')
    chat.add_argument('--model', required=True, help='Cline-native model id, not provider-prefixed spec')
    chat.add_argument('--variant')
    args = parser.parse_args()
    run = Run(args.run)
    if args.command == 'start':
        run.start(args.opencode, args.port)
    elif args.command == 'chat':
        run.chat(args.model, args.variant)
    else:
        getattr(run, args.command.replace('-', '_'))()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print('BLOCKED: ' + str(redact(str(error))), file=sys.stderr)
        sys.exit(1)
