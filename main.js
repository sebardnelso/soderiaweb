const { app, BrowserWindow } = require('electron');

function createWindow() {
  // Crea la ventana del navegador.
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false, // No se requiere integración con Node en la ventana
      contextIsolation: true  // Para mayor seguridad
    }
  });

  // Carga la URL de tu aplicación en la nube.
  win.loadURL('https://soderiaweb.onrender.com');

  // Opcional: abre las herramientas de desarrollo para depurar
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

// En macOS es común que la aplicación permanezca activa hasta que se cierre explícitamente.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // En macOS se vuelve a crear la ventana cuando se hace clic en el ícono
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
