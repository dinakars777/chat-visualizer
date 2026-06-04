const http = require("http");
const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");

const DEFAULT_PORT = Number(process.env.PORT || 4173);
const HOST = "127.0.0.1";

let mainWindow = null;
let ownedServer = null;

function extendFinderPath() {
  const commonPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const current = new Set(String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  for (const item of commonPaths) current.add(item);
  process.env.PATH = Array.from(current).join(path.delimiter);
}

function readLocalStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: HOST,
      port,
      path: "/api/status",
      timeout: 800
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) req.destroy();
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const payload = JSON.parse(body);
          resolve(Boolean(payload && typeof payload.status === "string"));
        } catch {
          resolve(false);
        }
      });
    });

    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function resolveAppUrl() {
  if (await readLocalStatus(DEFAULT_PORT)) {
    return `http://${HOST}:${DEFAULT_PORT}`;
  }

  const { startServer } = require("../server");

  try {
    const started = await startServer({ host: HOST, port: DEFAULT_PORT });
    ownedServer = started.server;
    return started.url;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }

  const started = await startServer({ host: HOST, port: 0 });
  ownedServer = started.server;
  return started.url;
}

function installMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const appUrl = await resolveAppUrl();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 720,
    title: "ChatVisualizer",
    backgroundColor: "#edf5f4",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(appUrl);
}

extendFinderPath();
app.name = "ChatVisualizer";

app.whenReady().then(async () => {
  installMenu();
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("ChatVisualizer failed to start", error.message);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => dialog.showErrorBox("ChatVisualizer failed to start", error.message));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (ownedServer) {
    ownedServer.close();
    ownedServer = null;
  }
});
