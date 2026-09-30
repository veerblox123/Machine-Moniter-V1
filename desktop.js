const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let monitorProcess;
let mainWindow;

function waitForMonitor(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('The local monitor did not start in time.')), 15000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Machine Monitor running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
      if (output.length > 6000) output = output.slice(-3000);
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The local monitor exited${code === null ? '' : ` with code ${code}`}. ${output.slice(-1200)}`));
    });
  });
}

function startMonitor() {
  const appFiles = app.isPackaged ? process.resourcesPath : __dirname;
  const serverPath = path.join(appFiles, 'server.js');
  monitorProcess = spawn(process.execPath, [serverPath], {
    cwd: appFiles,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return waitForMonitor(monitorProcess);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#090d12',
    title: 'Machine Monitor',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const port = await startMonitor();
    createWindow(`http://127.0.0.1:${port}`);
  } catch (error) {
    dialog.showErrorBox('Machine Monitor could not start', error.message);
    app.quit();
  }
});

app.on('before-quit', () => { if (monitorProcess && !monitorProcess.killed) monitorProcess.kill(); });
app.on('window-all-closed', () => app.quit());
