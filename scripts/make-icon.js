const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'build', 'icon.html'));
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const buildDir = path.join(__dirname, '..', 'build');
  const png = path.join(buildDir, 'icon.png');
  fs.writeFileSync(png, image.resize({ width: 1024, height: 1024 }).toPNG());
  const iconset = path.join(app.getPath('temp'), `termhub-${process.pid}.iconset`);
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  app.quit();
});
