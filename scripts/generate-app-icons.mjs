import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public', 'favicon.svg');
const buildDir = path.join(root, 'build');
const electronAssetsDir = path.join(root, 'electron', 'assets');

await Promise.all([
  fs.mkdir(buildDir, { recursive: true }),
  fs.mkdir(electronAssetsDir, { recursive: true }),
]);

const iconPng = await sharp(source, { density: 384 })
  .resize(256, 256)
  .png()
  .toBuffer();

const trayPng = await sharp(source, { density: 192 })
  .resize(32, 32)
  .png()
  .toBuffer();

const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);

const icoEntry = Buffer.alloc(16);
icoEntry.writeUInt8(0, 0);
icoEntry.writeUInt8(0, 1);
icoEntry.writeUInt8(0, 2);
icoEntry.writeUInt8(0, 3);
icoEntry.writeUInt16LE(1, 4);
icoEntry.writeUInt16LE(32, 6);
icoEntry.writeUInt32LE(iconPng.length, 8);
icoEntry.writeUInt32LE(22, 12);

await Promise.all([
  fs.writeFile(path.join(buildDir, 'icon.png'), iconPng),
  fs.writeFile(path.join(buildDir, 'icon.ico'), Buffer.concat([icoHeader, icoEntry, iconPng])),
  fs.writeFile(path.join(electronAssetsDir, 'pasty-tray.png'), trayPng),
]);

console.log('Generated Pasty application and tray icons.');
