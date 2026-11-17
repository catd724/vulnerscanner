/**
 * terminal.ai - Electron shell.
 *
 * Keeps the original bootstrap (find a free port, fork the Next server, wait
 * for it to answer, then load it) and adds: the vault database living in
 * userData, a native menu with the app's own shortcuts, and a clean shutdown
 * that closes SSH sessions before the window disappears.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { fork } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

/** Walk upward from startPort until a port is free. */
function getFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(getFreePort(startPort + 1));
      else reject(err);
    });
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() > deadline) {
        reject(new Error('The local server did not start in time'));
        return;
      }
      http
        .get(url, (res) => {
          // Any answer means Next is up; the app itself handles its own routing.
          if (res.statusCode && res.statusCode < 500) resolve();
          else setTimeout(check, 150);
          res.resume();
        })
        .on('error', () => setTimeout(check, 150));
    };
    check();
  });
}

function resolveDbPath() {
  if (!app.isPackaged) return path.resolve(__dirname, 'connections.db');

  const userDataPath = app.getPath('userData');
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });

  const dbPath = path.join(userDataPath, 'connections.db');

  // Carry an existing database out of the app folder on first packaged run;
  // inside an asar it would be read-only.
  const bundledDb = path.join(__dirname, 'connections.db');
  if (!fs.existsSync(dbPath) && fs.existsSync(bundledDb)) {
    try {
      fs.copyFileSync(bundledDb, dbPath);
      console.log('[electron] Migrated connections.db to', dbPath);
    } catch (err) {
      console.error('[electron] Could not migrate the database:', err.message);
    }
  }

  return dbPath;
}

function buildMenu() {
  const template = [
    {
      label: 'AI Terminal',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Reload window',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.reload(),
        },
        {
          label: 'Toggle developer tools',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in browser',
          click: () => serverPort && shell.openExternal(`http://127.0.0.1:${serverPort}`),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  serverPort = await getFreePort(3000);
  const dbPath = resolveDbPath();

  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      NODE_ENV: app.isPackaged ? 'production' : 'development',
      DB_PATH: dbPath,
      TERMINALAI_ROOT: __dirname,
    },
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && !app.isQuitting) {
      dialog.showErrorBox('AI Terminal', `The local server exited unexpectedly (code ${code}).`);
    }
  });

  const serverUrl = `http://127.0.0.1:${serverPort}`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#08090f',
    title: 'AI Terminal',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the real browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    await waitForServer(serverUrl);
    await mainWindow.loadURL(serverUrl);
  } catch (err) {
      dialog.showErrorBox('AI Terminal', err.message);
    app.quit();
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  if (serverProcess) {
    // SIGTERM lets server.js close SSH sessions and unbind tunnel ports first.
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
