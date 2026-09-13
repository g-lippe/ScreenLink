// Dev-only: a separate Electron process that renders a 60 fps animation and plays a tone.
// Being its own process tree makes it a clean target for the audio helper's include/exclude modes.
//   node_modules/electron/dist/electron.exe dev/test-pattern/main.js [--silent]
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setPath('userData', path.join(app.getPath('temp'), 'screenlink-test-pattern'));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    title: 'ScreenLink Test Pattern',
    autoHideMenuBar: true,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  const silent = process.argv.includes('--silent');
  win.loadFile(path.join(__dirname, 'index.html'), { query: { silent: silent ? '1' : '0' } });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('console-message', (e) => console.log(e.message));
  console.log(`test-pattern pid=${process.pid}`);
});
app.on('window-all-closed', () => app.quit());
