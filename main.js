'use strict';
const fs = require('fs');
const os = require('os');
const logPath = require('path').join(os.homedir(), 'Desktop', 'eltarzy-error.txt');
function logError(msg) {
  try { fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] ${msg}`); } catch(e){}
}
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION: ' + err.stack);
});
process.on('unhandledRejection', (err) => {
  logError('UNHANDLED REJECTION: ' + (err ? err.stack : err));
});
logError('=== APP STARTING ===');

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { setupIpcHandlers, createBackup, copyBackupToExternal, saveWhatsAppMessage, deleteWhatsAppConversation, deleteWhatsAppMessage } = require('./database/db');
const {
  initWhatsAppManagerWithApp,
  switchProvider,
  getActiveProvider,
  getActiveProviderSafe,
  getWhatsAppSettings,
  saveWhatsAppSettings,
  getTemplateMap,
  saveTemplateMap,
  sendTextMessage,
  syncTunnelUrlWithMeta,
} = require('./whatsapp/whatsapp-manager');
const {
  startWebhookServer,
  stopWebhookServer,
  getWebhookServerStatus,
  processIncomingWebhook,
} = require('./whatsapp/webhook-server');
const {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  restartTunnel,
} = require('./whatsapp/webhook-tunnel');
const { setupActivationIpc, getActivationStatus } = require('./activation');
const { startPerformanceManager, stopPerformanceManager } = require('./performance-manager');

let mainWindow = null;
let allowQuit = false;

async function initWebhookAndTunnel(db, win) {
  try {
    const settings = getWhatsAppSettings(db);
    const port = settings.webhook_port || 3000;
    const verifyToken = settings.webhook_verify_token || 'eltarzy_wa_token';

    const serverRes = await startWebhookServer({
      port,
      verifyToken,
      mainWindow: win,
      saveMessageFn: saveWhatsAppMessage
    });

    if (serverRes.success && settings.webhook_auto_tunnel !== 0) {
      startTunnel(port, win).then(tunnelStatus => {
        if (tunnelStatus && tunnelStatus.status === 'connected' && tunnelStatus.webhookUrl) {
          syncTunnelUrlWithMeta(tunnelStatus.webhookUrl).then(syncRes => {
            if (syncRes && syncRes.success) {
              logError('ðŸŽ¯ [Main] ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±Ø§Ø¨Ø· Ø§Ù„Ù€ Webhook ÙÙŠ Meta ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹: ' + tunnelStatus.webhookUrl);
              if (win && !win.isDestroyed()) {
                win.webContents.send('whatsapp:meta-synced', { success: true, url: tunnelStatus.webhookUrl });
              }
            } else {
              logError('âš ï¸ [Main] ÙØ´Ù„Øª Ù…Ø²Ø§Ù…Ù†Ø© Ø±Ø§Ø¨Ø· Ø§Ù„Ù†ÙÙ‚ Ù…Ø¹ Meta: ' + (syncRes ? syncRes.error : 'Ø®Ø·Ø£ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ'));
              if (win && !win.isDestroyed()) {
                win.webContents.send('whatsapp:meta-synced', { success: false, error: syncRes ? syncRes.error : 'ØªØ¹Ø°Ø± Ø§Ù„ØªØ­Ù‚Ù‚ ÙÙŠ Meta' });
              }
            }
          }).catch(err => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('whatsapp:meta-synced', { success: false, error: err.message });
            }
          });
        }
      }).catch(e => console.warn('[Tunnel] Warning:', e.message));
    }
  } catch (err) {
    console.error('[Main] Failed to initialize webhook/tunnel:', err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#F0F2F7',  // Ø§Ù„Ù…Ø·Ø§Ø¨Ù‚Ø© Ø§Ù„ØªØ§Ù…Ø© Ù„Ù„ÙˆÙ† Ø®Ù„ÙÙŠØ© Ø§Ù„ØªØ·Ø¨ÙŠÙ‚ Ù„Ù…Ø­Ùˆ Ø£ÙŠ ÙˆÙ…ÙŠØ¶
    title: 'Ø§Ù„ØªØ±Ø²ÙŠ â€” Ù†Ø¸Ø§Ù… Ø¥Ø¯Ø§Ø±Ø© Ù…Ø­Ù„ Ø§Ù„ØªØ±Ø²ÙŠ',
    ...(fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {}),
    show: false  // Ù†Ø®ÙÙŠÙ‡Ø§ Ø­ØªÙ‰ ØªÙƒØªÙ…Ù„ Ù„Ù…Ù†Ø¹ Ø§Ù„ÙˆÙ…ÙŠØ¶
  });
  logError('BrowserWindow created.');

  // Ø¯Ø§Ø¦Ù…Ø§Ù‹ Ø§ÙØªØ­ ØµÙØ­Ø© Ø§Ù„Ø¯Ø®ÙˆÙ„ â€” Ø§Ù„Ø¯Ø§Ø´Ø¨ÙˆØ±Ø¯ ÙŠØªØ­ÙƒÙ… ÙÙŠ ÙˆØ¶Ø¹ Ø§Ù„ØªØ¬Ø±Ø¨Ø©/Ø§Ù„Ù‚Ø±Ø§Ø¡Ø© ÙÙ‚Ø·
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  let windowShown = false;
  mainWindow.once('ready-to-show', () => {
    if (!windowShown) {
      windowShown = true;
      mainWindow.show();
      mainWindow.maximize();
    }
  });

  // Fallback for Windows 7: Ø§Ù„Ø¥Ø¬Ø¨Ø§Ø± Ø¹Ù„Ù‰ Ø¥Ø¸Ù‡Ø§Ø± Ø§Ù„Ù†Ø§ÙØ°Ø© Ø¥Ø°Ø§ Ù„Ù… ÙŠÙØ·Ù„Ù‚ Ø§Ù„Ø­Ø¯Ø«
  setTimeout(() => {
    if (!windowShown && mainWindow) {
      windowShown = true;
      mainWindow.show();
      mainWindow.maximize();
    }
  }, 1500);

  mainWindow.webContents.once('did-finish-load', () => {
    // ØªØ£Ø®ÙŠØ± 5 Ø«ÙˆØ§Ù†Ù ÙÙ‚Ø· â€” ÙˆÙ‚Øª ÙƒØ§ÙÙ Ù„ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„
    setTimeout(() => {
      const { getDb } = require('./database/db');
      const db = getDb(app);
      initWhatsAppManagerWithApp(db, mainWindow, app).catch(err => {
        logError('[Main] ÙØ´Ù„ ØªØ´ØºÙŠÙ„ WhatsApp Manager: ' + err.message);
      });
      initWebhookAndTunnel(db, mainWindow).catch(err => {
        logError('[Main] ÙØ´Ù„ ØªØ´ØºÙŠÙ„ Webhook/Tunnel: ' + err.message);
      });
    }, 5000);
  });

  // â”€â”€â”€ Graceful Shutdown â€” Backup Confirmation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message}`);
  });

  mainWindow.on('close', (e) => {
    if (!allowQuit) {
      e.preventDefault();
      mainWindow.webContents.send('confirm-backup-before-quit');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// â”€â”€â”€ App Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ disableHardwareAcceleration Ù„Ù…Ù†Ø¹ Ø¸Ù‡ÙˆØ± ÙˆÙ…ÙŠØ¶ Ø§Ù„Ø¯ÙŠØ³ÙƒØªÙˆØ¨ Ø¹Ù†Ø¯ Ø§Ù„ØªÙ†Ù‚Ù„ ÙÙŠ ÙˆÙŠÙ†Ø¯ÙˆØ²
app.disableHardwareAcceleration();

// â”€â”€â”€ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ø£Ø¯Ø§Ø¡ + Windows 10 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  setupIpcHandlers(ipcMain, app);
  setupActivationIpc(ipcMain, app);  // â† Ù†Ø¸Ø§Ù… Ø§Ù„ØªÙØ¹ÙŠÙ„
  createWindow();

  // Ø¨Ø¯Ø¡ Performance Manager Ø¨Ø¹Ø¯ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù†Ø§ÙØ°Ø©
  startPerformanceManager(__dirname);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPerformanceManager();
  stopWebhookServer();
  stopTunnel();
  if (process.platform !== 'darwin') app.quit();
});

// â”€â”€â”€ Quit flow IPC handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.on('quit-with-backup', async () => {
  try {
    await createBackup('ØªÙ„Ù‚Ø§Ø¦ÙŠ Ø¹Ù†Ø¯ Ø§Ù„Ø®Ø±ÙˆØ¬');
  } catch (e) {
    logError('Backup before quit failed: ' + e.message);
  }
  allowQuit = true;
  app.quit();
});

ipcMain.on('quit-without-backup', () => {
  allowQuit = true;
  app.quit();
});

ipcMain.on('cancel-quit', () => {
  // Do nothing â€” the quit was already prevented
});

// â”€â”€â”€ Navigation IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('navigate', async (_, page) => {
  if (!mainWindow) return;
  const pagePath = path.join(__dirname, 'renderer', page);
  mainWindow.loadFile(pagePath);
});

// â”€â”€â”€ Focus Recovery IPC (Windows keyboard fix) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('window:requestFocus', () => {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    // Ø§Ù„Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø£ÙƒØ«Ø± ÙØ¹Ø§Ù„ÙŠØ© Ù„ÙÙƒ ØªØ¹Ù„ÙŠÙ‚ Ø§Ù„ÙƒÙŠØ¨ÙˆØ±Ø¯ ÙÙŠ ÙˆÙŠÙ†Ø¯ÙˆØ²
    mainWindow.blur();
    mainWindow.focus();
  } else {
    mainWindow.focus();
  }
  mainWindow.webContents.focus();
});

// â”€â”€â”€ Print IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('print', async (_, options) => {
  if (!mainWindow) return false;
  
  const printOptions = {
    silent: true,
    printBackground: true,
    color: false,
    margins: { marginType: 'none' },
    ...options
  };

  return new Promise((resolve) => {
    mainWindow.webContents.print(printOptions, (success, errorType) => {
      resolve(success);
    });
  });
});

// â”€â”€â”€ File Dialog IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('dialog:showSaveDialog', async (_, options) => {
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('dialog:showOpenDialog', async (_, options) => {
  return dialog.showOpenDialog(mainWindow, options);
});

// â”€â”€â”€ Print to PDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('app:printToPDF', async (event, savePath) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: false,
      marginsType: 1  // 0=default, 1=no margin, 2=minimum
    });
    fs.writeFileSync(savePath, pdfBuffer);
    return { success: true, path: savePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('app:selectFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Ø§Ø®ØªØ± Ù…Ø¬Ù„Ø¯ Ø­ÙØ¸ Ø§Ù„ØªÙ‚Ø§Ø±ÙŠØ±'
  });
  if (res.canceled || !res.filePaths.length) return { success: false };
  return { success: true, path: res.filePaths[0] };
});

// â”€â”€â”€ Open External Link â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url);
});

// â”€â”€â”€ Generate Daily Report PDF in hidden window & send via WhatsApp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('app:generateAndSendReport', async (_, { date, savePath, phone }) => {
  return new Promise((resolve) => {
    try {
      const reportWin = new BrowserWindow({
        width: 1200,
        height: 900,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      });

      const reportUrl = path.join(__dirname, 'renderer', 'daily-report.html');
      reportWin.loadFile(reportUrl);

      // Ø§Ù†ØªØ¸Ø± Ø§ÙƒØªÙ…Ø§Ù„ Ø§Ù„ØªØ­Ù…ÙŠÙ„ ÙˆØªØ­Ø¯ÙŠØ¯ Ø§Ù„ØªØ§Ø±ÙŠØ®
      reportWin.webContents.on('did-finish-load', () => {
        // Ø£Ø±Ø³Ù„ Ù„Ù„Ù€ renderer Ø§Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ù…Ø·Ù„ÙˆØ¨ Ø«Ù… Ø§Ù†ØªØ¸Ø± Ø¹Ù„Ø§Ù…Ø© "Ø¬Ø§Ù‡Ø² Ù„Ù„Ù€ PDF"
        reportWin.webContents.executeJavaScript(`
          (async () => {
            try {
              document.getElementById('reportDate').value = '${date}';
              await loadDailyReport();
              enablePrintMode();
              await new Promise(r => setTimeout(r, 600));
              return 'ready';
            } catch(e) {
              return 'error:' + e.message;
            }
          })()
        `).then(async (result) => {
          if (result && result.startsWith('error:')) {
            reportWin.destroy();
            return resolve({ success: false, error: result });
          }

          try {
            const pdfBuffer = await reportWin.webContents.printToPDF({
              printBackground: true,
              pageSize: 'A4',
              landscape: false,
              marginsType: 1
            });
            fs.writeFileSync(savePath, pdfBuffer);
            reportWin.destroy();
            resolve({ success: true, path: savePath });
          } catch (pdfErr) {
            reportWin.destroy();
            resolve({ success: false, error: pdfErr.message });
          }
        }).catch((err) => {
          reportWin.destroy();
          resolve({ success: false, error: err.message });
        });
      });

      reportWin.webContents.on('did-fail-load', (e, code, desc) => {
        reportWin.destroy();
        resolve({ success: false, error: 'ÙØ´Ù„ ØªØ­Ù…ÙŠÙ„ ØµÙØ­Ø© Ø§Ù„ØªÙ‚Ø±ÙŠØ±: ' + desc });
      });

      // Ø­Ø¯ Ø£Ù‚ØµÙ‰ 30 Ø«Ø§Ù†ÙŠØ©
      setTimeout(() => {
        if (!reportWin.isDestroyed()) {
          reportWin.destroy();
          resolve({ success: false, error: 'Ø§Ù†ØªÙ‡Øª Ù…Ù‡Ù„Ø© ØªÙˆÙ„ÙŠØ¯ Ø§Ù„ØªÙ‚Ø±ÙŠØ±' });
        }
      }, 30000);

    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
});

// â”€â”€â”€ App info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));

// â”€â”€â”€ Restart app (for backup restore) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('app:restart', () => {
  app.relaunch();
  allowQuit = true;
  app.quit();
});

// â”€â”€â”€ Get logo as file:// URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle('app:getLogoPath', (_, logoDbPath) => {
  if (!logoDbPath) return null;
  if (fs.existsSync(logoDbPath)) {
    return `file://${logoDbPath.replace(/\\/g, '/')}`;
  }
  return null;
});

// â”€â”€â”€ Helper: Ø¬Ù„Ø¨ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ø­Ù„ Ù…Ù† Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getShopSettings() {
  try {
    const { getDb } = require('./database/db');
    const db  = getDb(app);
    const row = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    return row || {};
  } catch (e) {
    return {};
  }
}

function getAppDb() {
  const { getDb } = require('./database/db');
  return getDb(app);
}

// â”€â”€â”€ WhatsApp IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Ø­Ø§Ù„Ø© Ø§Ù„Ù…Ø²ÙˆÙ‘Ø¯ Ø§Ù„Ù†Ø´Ø·
ipcMain.handle('whatsapp:getStatus', async () => {
  try {
    const provider = getActiveProviderSafe();
    if (!provider) return { ready: false, statusType: 'disconnected', label: 'ØºÙŠØ± Ù…Ù‡ÙŠØ£', hasQR: false };
    const status = await provider.getStatus();
    return { ...status, hasQR: status.needsQR || false };
  } catch (e) {
    return { ready: false, statusType: 'disconnected', label: e.message, hasQR: false };
  }
});

// Ø¬Ù„Ø¨ QR (Ù„Ù„ØªÙˆØ§ÙÙ‚ Ù…Ø¹ Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ù‚Ø¯ÙŠÙ… ÙÙŠ preload)
ipcMain.handle('whatsapp:getQR', async () => {
  try {
    const provider = getActiveProviderSafe();
    if (!provider) return { success: false, qr: null };
    const status = await provider.getStatus();
    if (status.needsQR && status.qrImage) {
      return { success: true, qr: status.qrImage };
    }
    return { success: false, qr: null };
  } catch {
    return { success: false, qr: null };
  }
});

// Ø¥Ø±Ø³Ø§Ù„ Ù†ØµÙŠ Ø­Ø± (legacy â€” Ù„Ù„ØªÙˆØ§ÙÙ‚ Ù…Ø¹ Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ù‚Ø¯ÙŠÙ…)
ipcMain.handle('whatsapp:send', async (_, phone, message) => {
  const manager = require('./whatsapp/whatsapp-manager');
  return await manager.enqueueMessage(phone, 'custom', { customText: message }, true);
});

ipcMain.handle('whatsapp:sendFile', async (_, phone, caption, filePath, extraData) => {
  const manager = require('./whatsapp/whatsapp-manager');
  return await manager.sendFile(phone, caption, filePath, extraData);
});

// ØªØ£ÙƒÙŠØ¯ Ø§Ù„ÙØ§ØªÙˆØ±Ø© Ø¹Ù†Ø¯ Ø§Ù„Ø­ÙØ¸
ipcMain.handle('whatsapp:sendInvoiceConfirm', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'invoice_confirm', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// Ø§Ù„Ø·Ù„Ø¨ Ø¬Ø§Ù‡Ø² Ù„Ù„Ø§Ø³ØªÙ„Ø§Ù…
ipcMain.handle('whatsapp:sendOrderReady', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'order_ready', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// ØªÙ… Ø§Ù„ØªØ³Ù„ÙŠÙ…
ipcMain.handle('whatsapp:sendDelivered', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'order_delivered', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// ØªØ³Ø¯ÙŠØ¯ ÙƒØ§Ù…Ù„ + ØªØ³Ù„ÙŠÙ…
ipcMain.handle('whatsapp:sendDeliveredWithFullPayment', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'full_payment', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// Ø¯ÙØ¹Ø© Ø¬Ø²Ø¦ÙŠØ©
ipcMain.handle('whatsapp:sendPartialPayment', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'partial_payment', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// Ø³Ø¯Ø§Ø¯ ÙƒØ§Ù…Ù„ Ø¨Ø¯ÙˆÙ† ØªØ³Ù„ÙŠÙ… (Ù†ÙØ³ Ù†ÙˆØ¹ full_payment)
ipcMain.handle('whatsapp:sendFullPayment', async (_, data) => {
  if (!data.phone) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ù‚Ù… Ù‡Ø§ØªÙ Ù„Ù„Ø¹Ù…ÙŠÙ„' };
  try {
    return await getActiveProvider().sendMessage({
      type: 'full_payment', phone: data.phone, payload: data, settings: getShopSettings(),
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// Ù‚Ø·Ø¹ Ø§ØªØµØ§Ù„ Web.js (Ù„Ù„ØªÙˆØ§ÙÙ‚ Ù…Ø¹ Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ù‚Ø¯ÙŠÙ…)
ipcMain.handle('whatsapp:disconnect', async () => {
  try {
    const provider = getActiveProviderSafe();
    if (!provider) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ø²ÙˆÙ‘Ø¯ Ù†Ø´Ø·' };
    await provider.destroy();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// â”€â”€â”€ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„ÙˆØ§ØªØ³Ø§Ø¨ (Multi-Provider) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Ø¬Ù„Ø¨ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ø²ÙˆÙ‘Ø¯ Ø§Ù„Ø­Ø§Ù„ÙŠØ©
ipcMain.handle('whatsapp:getSettings', () => {
  try {
    const db = getAppDb();
    const settings = getWhatsAppSettings(db);
    // Ù„Ø§ Ù†ÙØ±Ø¬Ø¹ Ø§Ù„Ù€ Token Ø§Ù„Ù…ÙÙƒÙˆÙƒ Ù„Ù„Ù€ renderer (Ø£Ù…Ø§Ù†)
    const { wa_access_token_plain, wa_access_token, ...safeSettings } = settings;
    return { success: true, data: safeSettings };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø­ÙØ¸ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª ÙˆØ§Ù„ØªØ¨Ø¯ÙŠÙ„ Ø¨ÙŠÙ† Ø§Ù„Ù…Ø²ÙˆÙ‘Ø¯ÙŠÙ†
ipcMain.handle('whatsapp:saveSettings', async (_, newSettings) => {
  try {
    const db = getAppDb();
    // Ø­ÙØ¸ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª ÙÙŠ DB Ø£ÙˆÙ„Ø§Ù‹
    saveWhatsAppSettings(db, newSettings);
    // Ø§Ù„ØªØ¨Ø¯ÙŠÙ„ Ù„Ù„Ù…Ø²ÙˆÙ‘Ø¯ Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù…Ø¹ Rollback ØªÙ„Ù‚Ø§Ø¦ÙŠ Ø¹Ù†Ø¯ Ø§Ù„ÙØ´Ù„
    const result = await switchProvider(newSettings.provider, newSettings, db, app);
    if (!result.success) {
      // Ø£Ø¹ÙØ¯ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø© ÙÙŠ DB
      const oldSettings = getWhatsAppSettings(db);
      saveWhatsAppSettings(db, oldSettings);
    } else {
      initWebhookAndTunnel(db, mainWindow).catch(e => console.warn('[Main] Webhook restart error:', e.message));
    }
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø§Ø®ØªØ¨Ø§Ø± Ø§Ù„Ø§ØªØµØ§Ù„ Ø¨Ù€ Cloud API â€” GET ÙÙ‚Ø·ØŒ Ø¨Ø¯ÙˆÙ† Ø±Ø³Ø§Ù„Ø©
ipcMain.handle('whatsapp:testConnection', async (_, cfg) => {
  try {
    const CloudAPIProvider = require('./whatsapp/providers/cloud-api-provider');
    const tempProvider = new CloudAPIProvider();
    return await tempProvider.testConnection({
      phoneNumberId: cfg.wa_phone_number_id,
      accessToken:   cfg.wa_access_token_plain,
      apiVersion:    cfg.wa_api_version || 'v20.0',
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø¬Ù„Ø¨ Ø®Ø±ÙŠØ·Ø© Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨
ipcMain.handle('whatsapp:getTemplates', () => {
  try {
    const db = getAppDb();
    const map = getTemplateMap(db);
    return { success: true, data: map };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø­ÙØ¸ Ø®Ø±ÙŠØ·Ø© Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨
ipcMain.handle('whatsapp:saveTemplates', (_, templateMap) => {
  try {
    const db = getAppDb();
    saveTemplateMap(db, templateMap);
    // ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù€ provider Ø§Ù„Ù†Ø´Ø· Ø¨Ø®Ø±ÙŠØ·Ø© Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨ Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø©
    const provider = getActiveProviderSafe();
    if (provider && typeof provider.updateTemplateMap === 'function') {
      provider.updateTemplateMap(getTemplateMap(db));
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø§Ù„ØªØ­Ù‚Ù‚ Ù…Ù† Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨: Ø¬Ù„Ø¨ Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨ Ø§Ù„ÙØ¹Ù„ÙŠØ© Ù…Ù† Meta ÙˆÙ…Ù‚Ø§Ø±Ù†ØªÙ‡Ø§ Ø¨Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ø­Ù„ÙŠØ©
ipcMain.handle('whatsapp:verifyTemplates', async (_, cfg) => {
  try {
    const CloudAPIProvider = require('./whatsapp/providers/cloud-api-provider');
    const tempProvider = new CloudAPIProvider();

    // Ø¨Ù†Ø§Ø¡ Ø§Ù„Ù€ config â€” Ù†Ø³ØªØ®Ø¯Ù… Access Token Ø§Ù„Ù…ÙÙ…Ø±ÙŽÙ‘Ø± Ø£Ùˆ Ø§Ù„Ù…ÙØ®Ø²ÙŽÙ‘Ù†
    const db = getAppDb();
    const saved = getWhatsAppSettings(db);
    const accessToken = cfg?.wa_access_token_plain || saved?.wa_access_token_plain;
    const businessAccountId = cfg?.wa_business_account_id || saved?.wa_business_account_id;
    const phoneNumberId = cfg?.wa_phone_number_id || saved?.wa_phone_number_id;
    const apiVersion = cfg?.wa_api_version || saved?.wa_api_version || 'v20.0';

    if (!accessToken) {
      return { success: false, error: 'ÙŠØ±Ø¬Ù‰ Ø­ÙØ¸ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„ÙˆØ§ØªØ³Ø§Ø¨ Ø£ÙˆÙ„Ø§Ù‹ (Access Token Ù…Ø·Ù„ÙˆØ¨)' };
    }
    if (!businessAccountId) {
      return { success: false, error: 'ÙŠØ±Ø¬Ù‰ Ø¥Ø¯Ø®Ø§Ù„ WhatsApp Business Account ID ÙÙŠ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ù„Ø§Ø³ØªØ®Ø¯Ø§Ù… Ù‡Ø°Ù‡ Ø§Ù„Ù…ÙŠØ²Ø©' };
    }

    // Ø¬Ù„Ø¨ Ø§Ù„Ù‚ÙˆØ§Ù„Ø¨ Ø§Ù„ÙØ¹Ù„ÙŠØ© Ù…Ù† Meta
    const metaTemplates = await tempProvider.fetchAccountTemplates({
      accessToken, businessAccountId, phoneNumberId, apiVersion,
    });

    // Ø¨Ù†Ø§Ø¡ Ø®Ø±ÙŠØ·Ø© Ù„Ù„Ø¨Ø­Ø« Ø§Ù„Ø³Ø±ÙŠØ¹: { "template_name_ar": ["ar_EG", ...] }
    const metaMap = {};
    for (const tpl of metaTemplates) {
      const name = tpl.name.toLowerCase();
      if (!metaMap[name]) metaMap[name] = [];
      metaMap[name].push({ language: tpl.language, status: tpl.status });
    }

    // Ù…Ù‚Ø§Ø±Ù†Ø© Ù…Ø¹ Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ø­Ù„ÙŠØ©
    const localTemplates = getTemplateMap(db);
    const results = [];

    for (const [logicalKey, localInfo] of Object.entries(localTemplates)) {
      if (!localInfo.actual_template_name) {
        results.push({ logicalKey, status: 'empty', message: 'Ù„Ù… ÙŠØªÙ… Ø±Ø¨Ø· Ù‡Ø°Ø§ Ø§Ù„Ù‚Ø§Ù„Ø¨ Ø¨Ø¹Ø¯' });
        continue;
      }

      const localName = localInfo.actual_template_name.trim().toLowerCase();
      const localLang = (localInfo.language_code || 'ar_EG').trim().toLowerCase();

      const metaVersions = metaMap[localName];

      if (!metaVersions) {
        results.push({
          logicalKey,
          actual_template_name: localInfo.actual_template_name,
          language_code: localInfo.language_code,
          status: 'name_not_found',
          message: `âŒ Ø§Ø³Ù… Ø§Ù„Ù‚Ø§Ù„Ø¨ "${localInfo.actual_template_name}" ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ Ø¹Ù„Ù‰ Ø­Ø³Ø§Ø¨ Meta`,
        });
      } else {
        // Ø§Ù„Ø§Ø³Ù… Ù…ÙˆØ¬ÙˆØ¯ â€” Ù†ØªØ­Ù‚Ù‚ Ù…Ù† Ø§Ù„Ù„ØºØ©
        const langMatch = metaVersions.find(v => v.language.toLowerCase() === localLang);
        if (!langMatch) {
          const availableLangs = metaVersions.map(v => v.language).join(', ');
          results.push({
            logicalKey,
            actual_template_name: localInfo.actual_template_name,
            language_code: localInfo.language_code,
            status: 'lang_mismatch',
            message: `âš ï¸ Ø§Ø³Ù… Ø§Ù„Ù‚Ø§Ù„Ø¨ "${localInfo.actual_template_name}" Ù…ÙˆØ¬ÙˆØ¯ Ù„ÙƒÙ† ÙƒÙˆØ¯ Ø§Ù„Ù„ØºØ© Ø§Ù„Ù…ÙØ¯Ø®ÙŽÙ„ "${localInfo.language_code}" ØºÙŠØ± ØµØ­ÙŠØ­ â€” Ø§Ù„Ø£ÙƒÙˆØ§Ø¯ Ø§Ù„Ù…ØªØ§Ø­Ø© Ø¹Ù„Ù‰ Meta: ${availableLangs}`,
            availableLangs,
          });
        } else {
          results.push({
            logicalKey,
            actual_template_name: localInfo.actual_template_name,
            language_code: localInfo.language_code,
            status: langMatch.status === 'APPROVED' ? 'ok' : 'not_approved',
            message: langMatch.status === 'APPROVED'
              ? `âœ… Ø§Ù„Ù‚Ø§Ù„Ø¨ "${localInfo.actual_template_name}" Ù…Ø·Ø§Ø¨Ù‚ ÙˆÙ…Ø¹ØªÙ…Ø¯`
              : `âš ï¸ Ø§Ù„Ù‚Ø§Ù„Ø¨ "${localInfo.actual_template_name}" Ù…ÙˆØ¬ÙˆØ¯ Ù„ÙƒÙ† Ø­Ø§Ù„ØªÙ‡ "${langMatch.status}" (ØºÙŠØ± Ù…Ø¹ØªÙ…Ø¯ Ø¨Ø¹Ø¯)`,
          });
        }
      }
    }

    return {
      success: true,
      data: {
        results,
        metaTemplatesCount: metaTemplates.length,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// â”€â”€â”€ Ø¥Ø±Ø³Ø§Ù„ ÙˆØ§Ø³ØªÙ‚Ø¨Ø§Ù„ Ø±Ø³Ø§Ø¦Ù„ Ø§Ù„Ø´Ø§Øª ÙˆØ§Ù„Ù€ Webhook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Ø¥Ø±Ø³Ø§Ù„ Ø±Ø³Ø§Ù„Ø© Ù†ØµÙŠØ© Ø­Ø±Ø© Ù„Ø´Ø§Øª Ø§Ù„Ø¹Ù…ÙŠÙ„
ipcMain.handle('whatsapp:sendChatMessage', async (_, phone, text) => {
  try {
    return await sendTextMessage(phone, text);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø­Ø§Ù„Ø© Ø§Ù„Ù€ Webhook ÙˆØ§Ù„Ù†ÙÙ‚
ipcMain.handle('whatsapp:getWebhookInfo', () => {
  try {
    const db = getAppDb();
    const settings = getWhatsAppSettings(db);
    const serverStatus = getWebhookServerStatus();
    const tunnelStatus = getTunnelStatus();
    return {
      success: true,
      data: {
        server: serverStatus,
        tunnel: tunnelStatus,
        settings: {
          port: settings.webhook_port || 3000,
          verifyToken: settings.webhook_verify_token || 'eltarzy_wa_token',
          customUrl: settings.webhook_custom_url || '',
          autoTunnel: settings.webhook_auto_tunnel !== 0,
          provider: settings.provider
        }
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø¥Ø¹Ø§Ø¯Ø© ØªØ´ØºÙŠÙ„ Ø§Ù„Ù†ÙÙ‚ ÙŠØ¯ÙˆÙŠØ§Ù‹
ipcMain.handle('whatsapp:restartTunnel', async () => {
  try {
    const db = getAppDb();
    const settings = getWhatsAppSettings(db);
    const port = settings.webhook_port || 3000;
    const res = await restartTunnel(port, mainWindow);
    if (res && res.status === 'connected' && res.webhookUrl) {
      syncTunnelUrlWithMeta(res.webhookUrl).then(syncRes => {
        if (syncRes && syncRes.success) {
          logError('ðŸŽ¯ [Main] ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±Ø§Ø¨Ø· Ø§Ù„Ù€ Webhook ÙÙŠ Meta ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹ Ø¨Ø¹Ø¯ Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ØªØ´ØºÙŠÙ„: ' + res.webhookUrl);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('whatsapp:meta-synced', { success: true, url: res.webhookUrl });
          }
        } else {
          logError('âš ï¸ [Main] ÙØ´Ù„Øª Ù…Ø²Ø§Ù…Ù†Ø© Ø±Ø§Ø¨Ø· Ø§Ù„Ù†ÙÙ‚ Ù…Ø¹ Meta Ø¨Ø¹Ø¯ Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ØªØ´ØºÙŠÙ„: ' + (syncRes ? syncRes.error : 'Ø®Ø·Ø£ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ'));
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('whatsapp:meta-synced', { success: false, error: syncRes ? syncRes.error : 'ØªØ¹Ø°Ø± Ø§Ù„ØªØ­Ù‚Ù‚ ÙÙŠ Meta' });
          }
        }
      }).catch(err => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whatsapp:meta-synced', { success: false, error: err.message });
        }
      });
    }
    return { success: true, data: res };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ù…Ø²Ø§Ù…Ù†Ø© ÙŠØ¯ÙˆÙŠØ© Ø£Ùˆ ÙÙˆØ±ÙŠØ© Ù…Ø¹ Meta Graph API
ipcMain.handle('whatsapp:syncMetaWebhook', async (_, url) => {
  try {
    const targetUrl = url || getTunnelStatus()?.webhookUrl;
    if (!targetUrl) return { success: false, error: 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø±Ø§Ø¨Ø· Ù†ÙÙ‚ Ù†Ø´Ø· Ù„Ù„Ù…Ø²Ø§Ù…Ù†Ø©' };
    const res = await syncTunnelUrlWithMeta(targetUrl);
    if (res && res.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whatsapp:meta-synced', { success: true, url: targetUrl });
    }
    return res;
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Ø­Ø°Ù Ù…Ø­Ø§Ø¯Ø«Ø© ÙˆØ§ØªØ³Ø§Ø¨ ÙƒØ§Ù…Ù„Ø©
ipcMain.handle('whatsapp:deleteConversation', async (_, phone) => {
  return deleteWhatsAppConversation(phone);
});

// Ø­Ø°Ù Ø±Ø³Ø§Ù„Ø© ÙˆØ§Ø­Ø¯Ø©
ipcMain.handle('whatsapp:deleteMessage', async (_, id) => {
  return deleteWhatsAppMessage(id);
});

// Ø§Ø®ØªØ¨Ø§Ø± Ø§Ø³ØªÙ‚Ø¨Ø§Ù„ Ø±Ø³Ø§Ù„Ø© ØªØ¬Ø±ÙŠØ¨ÙŠØ© (Ping Test)
ipcMain.handle('whatsapp:testWebhookPing', (_, testPhone) => {
  try {
    const phone = testPhone || '201000000000';
    processIncomingWebhook({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ profile: { name: 'Ø¹Ù…ÙŠÙ„ ØªØ¬Ø±ÙŠØ¨ÙŠ' }, wa_id: phone }],
            messages: [{
              from: phone,
              id: 'test_' + Date.now(),
              type: 'text',
              text: { body: 'Ù…Ø±Ø­Ø¨Ø§Ù‹! Ù‡Ø°Ø§ Ø§Ø®ØªØ¨Ø§Ø± ÙÙˆØ±ÙŠ Ù„Ø§Ø³ØªÙ‚Ø¨Ø§Ù„ Ø±Ø³Ø§Ø¦Ù„ Ø§Ù„ÙˆØ§ØªØ³Ø§Ø¨ Ø¨Ù†Ø¬Ø§Ø­ ðŸš€' }
            }]
          }
        }]
      }]
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});


// ─── جلب التسجيل الصوتي من Meta Graph API وتحويله لـ base64 ─────────────────
ipcMain.handle('whatsapp:fetchAudio', async (_, mediaId) => {
  try {
    const { fetchAudioAsBase64 } = require('./whatsapp/whatsapp-manager');
    return await fetchAudioAsBase64(mediaId);
  } catch (e) {
    return { success: false, error: e.message };
  }
});
