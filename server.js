const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');

const ROOT = __dirname;
let PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) PORT = 3000;
let previousCpu = null;
const terminalSessions = new Map();
const authSessions = new Map();
const loginAttempts = new Map();
const AUTH_TTL = 8 * 60 * 60 * 1000;

function readCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = line[3] + (line[4] || 0);
    const total = line.reduce((a, b) => a + b, 0);
    let usage = 0;
    if (previousCpu) {
      const totalDelta = total - previousCpu.total;
      usage = totalDelta ? Math.max(0, Math.min(100, (1 - (idle - previousCpu.idle) / totalDelta) * 100)) : 0;
    }
    previousCpu = { total, idle };
    return usage;
  } catch {
    const loads = os.loadavg();
    return Math.min(100, (loads[0] / os.cpus().length) * 100);
  }
}

function command(file, args) {
  return new Promise(resolve => execFile(file, args, { timeout: 2500, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout)));
}
function run(file, args, timeout = 5000) {
  return new Promise(resolve => execFile(file, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
    stdout: stdout || '', stderr: stderr || '', code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
    unavailable: error?.code === 'ENOENT',
  })));
}

async function getServices() {
  const result = await run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager']);
  if (result.unavailable) return { available: false, reason: 'systemd is not installed on this host.', items: [] };
  if (result.code && !result.stdout) return { available: false, reason: result.stderr.trim() || 'Could not read system services. Try running the app as your user with systemd available.', items: [] };
  const items = result.stdout.split('\n').filter(Boolean).map(line => {
    const m = line.trim().match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    return m && { name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] };
  }).filter(Boolean);
  return { available: true, items };
}

async function getJournal() {
  const result = await run('journalctl', ['-n', '150', '--no-pager', '-o', 'short-iso-precise'], 8000);
  if (result.unavailable) return { available: false, reason: 'systemd journal tools are not installed.', items: [] };
  if (result.code && !result.stdout) return { available: false, reason: result.stderr.trim() || 'Journal access is restricted for this user.', items: [] };
  return { available: true, items: result.stdout.split('\n').filter(Boolean).reverse() };
}

async function getStorage() {
  const result = await run('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL']);
  if (result.unavailable) return { available: false, reason: 'lsblk is unavailable on this host.', devices: [] };
  try { return { available: true, devices: JSON.parse(result.stdout).blockdevices || [] }; }
  catch { return { available: false, reason: result.stderr.trim() || 'Could not read block devices.', devices: [] }; }
}

async function getNetwork() {
  const result = await run('ip', ['-j', 'address', 'show']);
  if (result.unavailable) return { available: true, items: Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({ name, state: 'unknown', addresses: (addresses || []).filter(a => !a.internal).map(a => `${a.address}/${a.cidr?.split('/')[1] || ''}`) })) };
  try {
    const items = JSON.parse(result.stdout).map(item => ({
      name: item.ifname, state: item.operstate, mac: item.address || '—', mtu: item.mtu,
      addresses: (item.addr_info || []).map(a => `${a.local}/${a.prefixlen}`),
    }));
    const routes = await run('ip', ['-j', 'route', 'show', 'default']);
    return { available: true, items, routes: (() => { try { return JSON.parse(routes.stdout).map(r => `${r.dst} via ${r.gateway || '—'} dev ${r.dev}`); } catch { return []; } })() };
  } catch { return { available: false, reason: result.stderr.trim() || 'Could not read network interfaces.', items: [] }; }
}

async function getAccounts() {
  const result = await run('getent', ['passwd']);
  if (result.unavailable || result.code) return { available: false, reason: 'Account directory information is unavailable.', items: [] };
  const items = result.stdout.split('\n').filter(Boolean).map(row => {
    const [name, , uid, gid, gecos, home, shell] = row.split(':');
    return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
  }).filter(user => user.uid >= 1000 && user.uid < 65534);
  return { available: true, items };
}

async function getUpdates() {
  const manager = await run('apt-get', ['-s', 'upgrade', '--no-install-recommends'], 20000);
  if (manager.unavailable) return { available: false, reason: 'No supported update manager detected. Debian-based systems use apt-get.', items: [] };
  const items = manager.stdout.split('\n').filter(line => line.startsWith('Inst ')).map(line => {
    const match = line.match(/^Inst\s+(\S+)(?:\s+\[([^\]]+)\])?\s+\(([^\s)]+)/);
    return match && { name: match[1], current: match[2] || 'not installed', candidate: match[3] };
  }).filter(Boolean);
  return { available: !manager.code, reason: manager.code ? manager.stderr.trim() || 'Update check failed. Refresh the package index with your package manager.' : '', items };
}

async function getContainers() {
  for (const engine of ['docker', 'podman']) {
    const result = await run(engine, ['ps', '--all', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    if (result.unavailable) continue;
    if (result.code) return { available: false, reason: result.stderr.trim() || `${engine} is installed, but this user cannot access it.`, items: [] };
    return { available: true, engine, items: result.stdout.split('\n').filter(Boolean).map(line => { const [id, name, image, status, ports] = line.split('\t'); return { id, name, image, status, ports }; }) };
  }
  return { available: false, reason: 'Install Docker or Podman to manage containers here.', items: [] };
}

async function getVirtualMachines() {
  const result = await run('virsh', ['list', '--all', '--name']);
  if (result.unavailable) return { available: false, reason: 'Install libvirt and virsh to manage virtual machines.', items: [] };
  if (result.code) return { available: false, reason: result.stderr.trim() || 'Could not connect to libvirt.', items: [] };
  const names = result.stdout.split('\n').filter(Boolean);
  const details = await Promise.all(names.map(async name => {
    const info = await run('virsh', ['domstate', name]);
    return { name, state: info.stdout.trim() || 'unknown' };
  }));
  return { available: true, items: details };
}

async function getFirewall() {
  const ufw = await run('ufw', ['status', 'verbose']);
  if (!ufw.unavailable) return { available: true, provider: 'ufw', status: ufw.stdout.trim(), reason: ufw.code ? ufw.stderr.trim() : '' };
  const firewalld = await run('firewall-cmd', ['--state']);
  if (!firewalld.unavailable) return { available: true, provider: 'firewalld', status: firewalld.stdout.trim() || firewalld.stderr.trim(), reason: firewalld.code ? firewalld.stderr.trim() : '' };
  return { available: false, reason: 'No supported firewall manager detected (UFW or firewalld).' };
}

async function getPackages() {
  const result = await run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n'], 12000);
  if (result.unavailable) return { available: false, reason: 'The dpkg package database is not available.', items: [] };
  return { available: !result.code, items: result.stdout.split('\n').filter(Boolean).map(line => { const [name, version] = line.split('\t'); return { name, version }; }).slice(0, 3000) };
}

async function getSystemModule(name) {
  switch (name) {
    case 'services': return getServices();
    case 'logs': return getJournal();
    case 'storage': return getStorage();
    case 'network': return getNetwork();
    case 'accounts': return getAccounts();
    case 'updates': return getUpdates();
    case 'containers': return getContainers();
    case 'virtual-machines': return getVirtualMachines();
    case 'firewall': return getFirewall();
    case 'packages': return getPackages();
    default: return null;
  }
}

async function actOnService(req, res) {
  try {
    const { name, action } = await readBody(req);
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_.@:-]+\.service$/.test(name) || !['start', 'stop', 'restart'].includes(action)) {
      json(res, 400, { error: 'Invalid service name or action.' }); return;
    }
    const args = ['systemctl', action, name];
    const result = process.getuid?.() === 0 ? await run(args[0], args.slice(1), 15000) : await run('sudo', ['-n', ...args], 15000);
    if (result.unavailable || result.code) { json(res, 403, { error: result.stderr.trim() || 'Action failed. This operation may require administrator permissions.' }); return; }
    json(res, 200, { ok: true, message: `${name} ${action} requested.` });
  } catch (error) { json(res, 400, { error: error.message }); }
}

async function getProcesses() {
  const raw = await command('ps', ['-eo', 'pid,comm,%cpu,%mem,rss,stat', '--sort=-%cpu']);
  return raw.split('\n').slice(1).filter(Boolean).slice(0, 9).map(row => {
    const m = row.trim().match(/^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)$/);
    return m && { pid: Number(m[1]), name: m[2], cpu: Number(m[3]), memory: Number(m[4]), rss: Number(m[5]), state: m[6] };
  }).filter(Boolean);
}

async function getDisk() {
  const raw = await command('df', ['-Pk', '/']);
  const row = raw.trim().split('\n')[1]?.trim().split(/\s+/);
  if (!row) return null;
  return { total: Number(row[1]) * 1024, used: Number(row[2]) * 1024, available: Number(row[3]) * 1024, percent: Number.parseInt(row[4], 10) || 0, mount: row[5] };
}

function getTemperature() {
  try {
    const dirs = fs.readdirSync('/sys/class/thermal');
    for (const dir of dirs.filter(x => x.startsWith('thermal_zone'))) {
      const raw = Number(fs.readFileSync(path.join('/sys/class/thermal', dir, 'temp'), 'utf8').trim());
      if (raw > 0) return Math.round(raw > 1000 ? raw / 1000 : raw);
    }
  } catch {}
  return null;
}

async function snapshot() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter(a => !a.internal).map(a => ({ name, address: a.address, family: a.family })));
  const [processes, disk] = await Promise.all([getProcesses(), getDisk()]);
  return {
    timestamp: new Date().toISOString(),
    host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), uptime: os.uptime(), node: process.version },
    cpu: { usage: readCpu(), model: cpus[0]?.model || 'Unknown processor', cores: cpus.length, load: os.loadavg() },
    memory: { total: totalMem, used: totalMem - freeMem, free: freeMem, percent: ((totalMem - freeMem) / totalMem) * 100 },
    disk, temperature: getTemperature(), interfaces, processes,
  };
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 24_000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function getCookie(req, name) {
  const entry = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function validSession(req) {
  const token = getCookie(req, 'monitor_session');
  const session = token && authSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created > AUTH_TTL) { authSessions.delete(token); return false; }
  session.lastUsed = Date.now();
  return true;
}
function sendLoginPage(res) {
  fs.readFile(path.join(ROOT, 'public', 'login.html'), (error, data) => {
    if (error) { res.writeHead(500); res.end('Login page unavailable'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(data);
  });
}
function verifyLaptopPassword(password) {
  return new Promise(resolve => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) { resolve({ available: false }); return; }
    const child = spawn('sudo', ['-k', '-S', '-p', '', '-v'], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, available: true }); }, 10000);
    child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 2000); });
    child.on('error', () => { clearTimeout(timer); resolve({ available: false }); });
    child.on('close', code => {
      clearTimeout(timer);
      // Clear the temporary sudo timestamp so the app doesn't leave an authenticated sudo ticket behind.
      const cleanup = spawn('sudo', ['-k'], { stdio: 'ignore' });
      cleanup.on('error', () => {});
      resolve({ ok: code === 0, available: true, stderr });
    });
    child.stdin.end(`${password}\n`);
  });
}
function attemptKey(req) { return req.socket.remoteAddress || 'local'; }
function checkAttemptLimit(req) {
  const key = attemptKey(req); const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  loginAttempts.set(key, attempts);
  return attempts.length < 5;
}
function recordFailedAttempt(req) {
  const key = attemptKey(req); const now = Date.now();
  loginAttempts.set(key, [...(loginAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000), now]);
}
function isLocalRequest(req) {
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(origin.hostname) && Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) === PORT;
  } catch { return false; }
}
function terminalOutput(session, text) {
  session.output += text;
  if (session.output.length > 500_000) session.output = session.output.slice(-500_000);
}
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function createTerminal(options = {}) {
  const id = randomUUID();
  const isWindows = os.platform() === 'win32';
  const requestedShell = process.env.SHELL || '/bin/bash';
  const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : (/^\/[a-zA-Z0-9/._+-]+$/.test(requestedShell) ? requestedShell : '/bin/bash');
  let commandLine = `${shell} -i`;
  if (options.type === 'ssh') {
    const { host, user, port } = options;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(host) || host.startsWith('-')) throw new Error('Enter a valid hostname or IP address.');
    if (user && (typeof user !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/.test(user))) throw new Error('Enter a valid SSH username.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid SSH port.');
    const target = user ? `${user}@${host}` : host;
    commandLine = ['ssh', '-tt', '-p', String(port), '--', target].map(shellQuote).join(' ');
  } else if (options.type === 'tmate') {
    commandLine = 'tmate -F';
  } else if (options.type === 'sshx') {
    commandLine = 'sshx';
  }
  // util-linux script provides the pseudo-terminal that interactive programs (including sudo) expect.
  const hasScript = os.platform() === 'linux' && ['/usr/bin/script', '/bin/script'].some(file => fs.existsSync(file));
  const executable = hasScript ? ['/usr/bin/script', '/bin/script'].find(file => fs.existsSync(file)) : shell;
  const args = hasScript ? ['-qfec', commandLine, '/dev/null'] : (options.type === 'ssh' ? ['-tt', '-p', String(options.port), '--', options.user ? `${options.user}@${options.host}` : options.host] : (isWindows ? [] : ['-i']));
  const launch = hasScript ? executable : options.type === 'ssh' ? 'ssh' : options.type === 'tmate' ? 'tmate' : options.type === 'sshx' ? 'sshx' : executable;
  const launchArgs = options.type === 'tmate' && !hasScript ? ['-F'] : args;
  const child = spawn(launch, launchArgs, {
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PS1: '\\u@\\h:\\w\\$ ', PROMPT: '$P$G ' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = { child, output: '', closed: false, lastUsed: Date.now() };
  child.stdout.on('data', chunk => terminalOutput(session, chunk.toString()));
  child.stderr.on('data', chunk => terminalOutput(session, chunk.toString()));
  child.on('error', error => { session.closed = true; terminalOutput(session, `\r\n[Could not start shell: ${error.message}]\r\n`); });
  child.on('close', code => { session.closed = true; terminalOutput(session, `\r\n[Process exited with code ${code ?? 0}]\r\n`); });
  terminalSessions.set(id, session);
  setTimeout(() => { if (terminalSessions.get(id) === session) { child.kill(); terminalSessions.delete(id); } }, 30 * 60 * 1000).unref();
  return id;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/auth/')) {
    if (!isLocalRequest(req)) { json(res, 403, { error: 'Login is limited to this machine.' }); return; }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') { json(res, 200, { authenticated: validSession(req), username: os.userInfo().username }); return; }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!checkAttemptLimit(req)) { json(res, 429, { error: 'Too many failed attempts. Wait 15 minutes and try again.' }); return; }
      try {
        const body = await readBody(req); const password = body.password;
        if (typeof password !== 'string' || !password.length || password.length > 1024) { json(res, 400, { error: 'Enter your laptop account password.' }); return; }
        const result = await verifyLaptopPassword(password);
        if (!result.available) { json(res, 503, { error: 'Password verification requires a non-root Linux account with sudo installed.' }); return; }
        if (!result.ok) { recordFailedAttempt(req); json(res, 401, { error: 'That password was not accepted for this laptop account.' }); return; }
        loginAttempts.delete(attemptKey(req));
        const token = randomBytes(32).toString('base64url');
        authSessions.set(token, { created: Date.now(), lastUsed: Date.now() });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `monitor_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL / 1000}` });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) { json(res, 400, { error: error.message }); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = getCookie(req, 'monitor_session'); if (token) authSessions.delete(token);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': 'monitor_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); res.end(JSON.stringify({ ok: true })); return;
    }
    json(res, 404, { error: 'Not found' }); return;
  }
  if (url.pathname.startsWith('/api/') && !validSession(req)) { json(res, 401, { error: 'Please sign in to use Machine Monitor.' }); return; }
  if (url.pathname.startsWith('/api/system/')) {
    if (!isLocalRequest(req)) { json(res, 403, { error: 'System controls are limited to this machine.' }); return; }
    if (req.method === 'POST' && url.pathname === '/api/system/service-action') { await actOnService(req, res); return; }
    if (req.method === 'GET') {
      const name = url.pathname.slice('/api/system/'.length);
      const data = await getSystemModule(name);
      if (!data) { json(res, 404, { error: 'Unknown system module.' }); return; }
      json(res, 200, data); return;
    }
    json(res, 405, { error: 'Method not allowed.' }); return;
  }
  if (url.pathname === '/api/processes') {
    if (req.method === 'GET') {
      const result = await run('ps', ['-eo', 'pid,ppid,comm,%cpu,%mem,rss,stat', '--sort=-%cpu'], 6000);
      if (result.unavailable || (result.code && !result.stdout)) { json(res, 200, { available: false, reason: result.stderr.trim() || 'Process list unavailable.', items: [] }); return; }
      const items = result.stdout.split('\n').slice(1).filter(Boolean).map(line => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)$/);
        return m && { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cpu: Number(m[4]), memory: Number(m[5]), rss: Number(m[6]) * 1024, state: m[7] };
      }).filter(Boolean);
      json(res, 200, { available: true, items }); return;
    }
    if (req.method === 'POST') {
      if (!isLocalRequest(req)) { json(res, 403, { error: 'Process controls are limited to this machine.' }); return; }
      try {
        const { pid } = await readBody(req);
        if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) { json(res, 400, { error: 'Invalid process ID.' }); return; }
        process.kill(pid, 'SIGTERM'); json(res, 200, { ok: true, message: `Termination signal sent to process ${pid}.` });
      } catch (error) { json(res, 403, { error: error.message }); }
      return;
    }
    json(res, 405, { error: 'Method not allowed.' }); return;
  }
  if (url.pathname.startsWith('/api/terminal')) {
    if (!isLocalRequest(req)) { json(res, 403, { error: 'Terminal access is limited to this machine.' }); return; }
    if (req.method === 'POST' && url.pathname === '/api/terminal/session') {
      try {
        const options = await readBody(req);
        if (!['local', 'ssh', 'tmate', 'sshx'].includes(options.type || 'local')) { json(res, 400, { error: 'Unknown terminal type.' }); return; }
        if (options.type === 'ssh' && (await run('ssh', ['-V'])).unavailable) { json(res, 503, { error: 'OpenSSH client is not installed on this machine.' }); return; }
        if (options.type === 'tmate') {
          const check = await run('tmate', ['-V']);
          if (check.unavailable) { json(res, 503, { error: 'tmate is not installed. Install it with your system package manager, then try again.' }); return; }
        }
        if (options.type === 'sshx' && (await run('sshx', ['--help'])).unavailable) { json(res, 503, { error: 'sshx is not installed. Install it with `curl -sSf https://sshx.io/get | sh`, then restart this app.' }); return; }
        const id = createTerminal({ ...options, port: options.type === 'ssh' ? Number(options.port) : options.port });
        json(res, 201, { id });
      } catch (error) { json(res, 400, { error: error.message }); }
      return;
    }
    const match = url.pathname.match(/^\/api\/terminal\/session\/([a-f0-9-]+)(?:\/(input|close))?$/);
    if (match) {
      const [, id, route] = match;
      const session = terminalSessions.get(id);
      if (!session) { json(res, 404, { error: 'Terminal session expired. Reopen the terminal.' }); return; }
      session.lastUsed = Date.now();
      if (req.method === 'GET' && !route) {
        const output = session.output; session.output = '';
        json(res, 200, { output, closed: session.closed }); return;
      }
      if (req.method === 'POST' && route === 'close') { session.child.kill(); terminalSessions.delete(id); json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && route === 'input') {
        try {
          const { input } = await readBody(req);
          if (typeof input !== 'string' || input.length > 20_000) { json(res, 400, { error: 'Input must be text under 20 KB.' }); return; }
          if (!session.closed) session.child.stdin.write(input);
          json(res, 202, { ok: true });
        } catch (error) { json(res, 400, { error: error.message }); }
        return;
      }
      if (req.method === 'DELETE') { session.child.kill(); terminalSessions.delete(id); json(res, 200, { ok: true }); return; }
    }
    json(res, 404, { error: 'Not found' }); return;
  }
  if (url.pathname === '/api/snapshot') {
    try { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(await snapshot())); }
    catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if ((url.pathname === '/' || url.pathname === '/index.html') && !validSession(req)) { sendLoginPage(res); return; }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(ROOT, 'public', `.${requested}`);
  if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'content-type': mime[path.extname(file)] || 'application/octet-stream' };
    if (path.extname(file) === '.html') headers['cache-control'] = 'no-store';
    res.writeHead(200, headers); res.end(data);
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the old server with Ctrl+C (resume a stopped job with "fg" first), or choose another port with PORT=3001 node server.js.`);
  else console.error(`Machine Monitor could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  console.log(`Machine Monitor running at http://127.0.0.1:${PORT}`);
});
