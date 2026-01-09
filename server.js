require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
// Backwards compatible: if you used FOLDER_ID previously, treat it as SCAN_FOLDER_ID
const SCAN_FOLDER_ID = process.env.SCAN_FOLDER_ID || process.env.GOOGLE_FOLDER_ID;
const QUARANTINE_FOLDER_ID = process.env.QUARANTINE_FOLDER_ID || null;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 15000;
const TOKEN_PATH = path.join(__dirname, 'tokens.json');
const SHEET_ID = process.env.SHEET_ID || null;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// NOTE: include spreadsheets scope for sheet updates and drive for moving/deleting files.
// After changing scopes, delete tokens.json and re-authorize.
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

let fileStore = []; // array of file objects with an added `source` field: 'scan'|'quarantine'
let pollTimer = null;
let isAuthorized = false;
let scanStore = {};       // { [fileId]: { status: 'pending'|'scanning'|'clean'|'infected', lastScannedAt: ISOString|null } }
const scanningJobs = new Set(); // track fileIds currently undergoing the simulated scan sequence

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(tokens);
      isAuthorized = true;
      console.log('✓ OAuth tokens loaded successfully');
      return true;
    }
  } catch (error) {
    console.error('Error loading tokens:', error.message);
  }
  return false;
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('✓ OAuth tokens saved successfully');
  } catch (error) {
    console.error('Error saving tokens:', error.message);
  }
}

/**
 * isEicarish(filename)
 * - returns true if the letters e,i,c,a,r appear in sequence (case-insensitive) with any characters between
 */
function isEicarish(filename) {
  if (!filename) return false;
  const s = filename.toLowerCase();
  const target = ['e', 'i', 'c', 'a', 'r'];
  let idx = 0;
  for (let i = 0; i < s.length && idx < target.length; i++) {
    if (s[i] === target[idx]) idx++;
  }
  return idx === target.length;
}

/**
 * Build and return the files array to emit to clients (merge scanStore data).
 * Each file now includes: source: 'scan'|'quarantine'
 */
function filesForClients() {
  return fileStore.map(f => {
    const record = scanStore[f.id] || { status: (f.source === 'quarantine' ? 'infected' : 'pending'), lastScannedAt: null };
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      webContentLink: f.webContentLink,
      md5Checksum: f.md5Checksum || null,
      scanStatus: record.status,
      lastScannedAt: record.lastScannedAt,
      source: f.source
    };
  });
}

/**
 * Helper to emit the current file list to all clients (uses merged files).
 * Also emits the configured folder IDs so the UI can show folder options.
 *
 * We also trigger a Google Sheets update (if SHEET_ID is set).
 */
function emitFileList(changes = { added: 0, modified: 0, deleted: 0 }) {
  const payload = {
    files: filesForClients(),
    timestamp: new Date().toISOString(),
    changes,
    folders: {
      scanFolderId: SCAN_FOLDER_ID,
      quarantineFolderId: QUARANTINE_FOLDER_ID
    }
  };

  io.emit('file_list', payload);

  // Update sheet asynchronously (do not block emit)
  if (SHEET_ID) {
    updateSheetFromFiles(payload.files).catch(err => {
      console.error('Sheet update failed:', err && err.message ? err.message : err);
      io.emit('scan_alert', { error: 'Sheet update failed: ' + (err && err.message ? err.message : String(err)) });
    });
  }
}

/**
 * List files in a single folder and tag the source.
 * Requests md5Checksum in fields.
 */
async function listFilesInFolder(folderId, sourceTag) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, md5Checksum)',
    orderBy: 'modifiedTime desc',
    pageSize: 1000
  });
  const files = response.data.files || [];
  return files.map(file => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size || '0',
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink || null,
    md5Checksum: file.md5Checksum || null,
    source: sourceTag // 'scan' or 'quarantine'
  }));
}

/**
 * Aggregate files from both scan and quarantine folders (if quarantine configured).
 * Deduplicate by file id (if same file appears in multiple sources, prefer quarantine).
 */
async function listFiles() {
  try {
    const scanFiles = SCAN_FOLDER_ID ? await listFilesInFolder(SCAN_FOLDER_ID, 'scan') : [];
    const quarantineFiles = (QUARANTINE_FOLDER_ID ? await listFilesInFolder(QUARANTINE_FOLDER_ID, 'quarantine') : []);

    // Build map with priority: quarantine over scan for duplicated ids
    const map = new Map();
    for (const f of scanFiles) map.set(f.id, f);
    for (const f of quarantineFiles) map.set(f.id, f); // overwrite if exists => quarantine wins

    const arr = Array.from(map.values()).sort((a, b) => {
      // sort by modifiedTime desc (fallback to name)
      if (a.modifiedTime && b.modifiedTime) return new Date(b.modifiedTime) - new Date(a.modifiedTime);
      return (b.name || '').localeCompare(a.name || '');
    });

    return arr;
  } catch (error) {
    console.error('Error listing files (combined):', error.message || error);
    throw error;
  }
}

/**
 * Detect changes between newFiles and fileStore.
 */
function detectChanges(newFiles) {
  const changes = {
    added: [],
    modified: [],
    deleted: [],
    hasChanges: false
  };

  const newFileMap = new Map(newFiles.map(f => [f.id, f]));
  const oldFileMap = new Map(fileStore.map(f => [f.id, f]));

  for (const [id, file] of newFileMap) {
    if (!oldFileMap.has(id)) {
      changes.added.push(file);
      changes.hasChanges = true;
    } else {
      const oldFile = oldFileMap.get(id);
      if (oldFile.modifiedTime !== file.modifiedTime || oldFile.source !== file.source) {
        changes.modified.push(file);
        changes.hasChanges = true;
        // Clear previous scan result so a fresh scan will run (only if file moved back to scan)
        delete scanStore[id];
      }
    }
  }

  for (const [id, file] of oldFileMap) {
    if (!newFileMap.has(id)) {
      changes.deleted.push(file);
      changes.hasChanges = true;
      delete scanStore[id];
    }
  }

  return changes;
}

/**
 * Move file to target folder (addParents/removeParents)
 * - When moving into QUARANTINE_FOLDER_ID -> mark infected.
 * - When moving into SCAN_FOLDER_ID -> mark clean and re-add to fileStore (fetch metadata).
 */
async function moveFileById(fileId, targetFolderId) {
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Get current parents and name
    const meta = await drive.files.get({
      fileId,
      fields: 'id, parents, name'
    });

    const currentParentsArray = meta.data.parents || [];
    const currentParents = currentParentsArray.join(',');

    // If already in target, nothing to do
    if (currentParentsArray.includes(targetFolderId)) {
      return { success: true, unchanged: true, name: meta.data.name };
    }

    // Update parents: add target, remove existing parents (to emulate move)
    const res = await drive.files.update({
      fileId,
      addParents: targetFolderId,
      removeParents: currentParents || undefined,
      fields: 'id, parents'
    });

    // Post-update: if moved out of the scan folder, remove it from server-side fileStore
    const stillHasScanParent = (res.data.parents || []).includes(SCAN_FOLDER_ID);
    if (!stillHasScanParent) {
      fileStore = fileStore.filter(f => f.id !== fileId);
      console.log(`File ${fileId} moved out of monitored scan folder -> removed from fileStore`);
    }

    // If moved into quarantine, ensure its scanStore marks infected
    if (QUARANTINE_FOLDER_ID && targetFolderId === QUARANTINE_FOLDER_ID) {
      scanStore[fileId] = {
        status: 'infected',
        lastScannedAt: new Date().toISOString()
      };
    }

    // If moved into scan folder, fetch metadata and add back to fileStore (so UI shows it immediately)
    if (SCAN_FOLDER_ID && targetFolderId === SCAN_FOLDER_ID) {
      try {
        const full = await drive.files.get({
          fileId,
          fields: 'id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, md5Checksum'
        });
        const fileMeta = full.data;
        const existing = fileStore.find(f => f.id === fileId);
        const item = {
          id: fileMeta.id,
          name: fileMeta.name,
          mimeType: fileMeta.mimeType,
          size: fileMeta.size || '0',
          modifiedTime: fileMeta.modifiedTime,
          webViewLink: fileMeta.webViewLink,
          webContentLink: fileMeta.webContentLink || null,
          md5Checksum: fileMeta.md5Checksum || null,
          source: 'scan'
        };
        if (!existing) {
          // insert into fileStore (keep sort by modifiedTime)
          fileStore.push(item);
          fileStore.sort((a, b) => {
            if (a.modifiedTime && b.modifiedTime) return new Date(b.modifiedTime) - new Date(a.modifiedTime);
            return (b.name || '').localeCompare(a.name || '');
          });
        } else {
          // update existing entry
          Object.assign(existing, item);
        }

        // mark as clean in scanStore
        scanStore[fileId] = {
          status: 'clean',
          lastScannedAt: new Date().toISOString()
        };
      } catch (errFetch) {
        console.warn('Warning: moved into scan but failed to fetch metadata:', errFetch && errFetch.message ? errFetch.message : errFetch);
      }
    }

    return { success: true, parents: res.data.parents };
  } catch (err) {
    console.error('Error moving file:', err && err.response && err.response.data ? err.response.data : (err && err.message ? err.message : err));
    return { success: false, error: (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) ? err.response.data.error.message : (err && err.message ? err.message : String(err)) };
  }
}

/**
 * Simulated scanning sequence (5-15s scanning, 1-10s pending)
 * Updated behaviour:
 * - Final infected decision depends ONLY on filename (isEicarish)
 * - Files that were in quarantine and do NOT match EICAR -> marked CLEAN and moved to SCAN_FOLDER_ID (if configured)
 * - Files that match EICAR (from any folder) -> INFECTED and (if configured) moved to QUARANTINE_FOLDER_ID
 */
function simulateScan(fileId, io) {
  return new Promise((resolve) => {
    if (scanningJobs.has(fileId)) return resolve();
    scanningJobs.add(fileId);

    const scanningMs = 5000 + Math.floor(Math.random() * (15000 - 5000 + 1)); // 5-15s
    const pendingMs = 1000 + Math.floor(Math.random() * (10000 - 1000 + 1));  // 1-10s

    // Immediately set scanning
    scanStore[fileId] = { status: 'scanning', lastScannedAt: null };
    emitFileList();

    setTimeout(() => {
      // pending
      scanStore[fileId] = { status: 'pending', lastScannedAt: null };
      io.emit('scan_complete', { fileId, status: 'pending', timestamp: new Date().toISOString(), message: 'Scan in progress (pending)' });
      emitFileList();

      setTimeout(async () => {
        try {
          const fileObj = fileStore.find(f => f.id === fileId);
          const name = fileObj ? fileObj.name : '';
          const source = fileObj ? fileObj.source : 'scan';

          // Final decision only by filename pattern (isEicarish). Quarantined files are not forcibly infected.
          const infectedByName = isEicarish(name);
          const infected = !!infectedByName;

          const finalStatus = infected ? 'infected' : 'clean';
          const now = new Date().toISOString();

          scanStore[fileId] = { status: finalStatus, lastScannedAt: now };

          io.emit('scan_complete', {
            fileId,
            status: finalStatus,
            timestamp: now,
            message: infected ? 'File flagged as infected (EICAR-like pattern)' : 'File is clean'
          });

          emitFileList();

          // If infected -> ensure quarantined (auto-move if configured and not already in quarantine)
          if (infected && QUARANTINE_FOLDER_ID) {
            const alreadyQuarantined = source === 'quarantine';
            if (!alreadyQuarantined) {
              console.log(`Auto-quarantine: moving file ${fileId} -> ${QUARANTINE_FOLDER_ID}`);
              const moveResult = await moveFileById(fileId, QUARANTINE_FOLDER_ID);
              if (moveResult.success) {
                io.emit('file_moved', { fileId, targetFolderId: QUARANTINE_FOLDER_ID, timestamp: new Date().toISOString(), message: 'Auto-quarantined infected file' });
                emitFileList();
              } else {
                console.error('Auto-quarantine failed:', moveResult.error);
                io.emit('scan_alert', { fileId, error: moveResult.error || 'Auto-quarantine failed' });
              }
            }
          }

          // If the file was in quarantine but is NOT infected -> move it back to scan folder (if configured)
          if (!infected && source === 'quarantine' && SCAN_FOLDER_ID) {
            try {
              console.log(`Auto-restore: moving quarantined clean file ${fileId} -> ${SCAN_FOLDER_ID}`);
              const moveResult = await moveFileById(fileId, SCAN_FOLDER_ID);
              if (moveResult.success) {
                io.emit('file_moved', { fileId, targetFolderId: SCAN_FOLDER_ID, timestamp: new Date().toISOString(), message: 'Restored clean file to scan folder' });
                emitFileList();
              } else {
                console.error('Auto-restore failed:', moveResult.error);
                io.emit('scan_alert', { fileId, error: moveResult.error || 'Auto-restore failed' });
              }
            } catch (errMove) {
              console.error('Auto-restore exception:', errMove && errMove.message ? errMove.message : errMove);
              io.emit('scan_alert', { fileId, error: errMove && errMove.message ? errMove.message : String(errMove) });
            }
          }
        } catch (err) {
          console.error('Error finalizing scan:', err && err.message ? err.message : err);
        } finally {
          scanningJobs.delete(fileId);
          resolve();
        }
      }, pendingMs);
    }, scanningMs);
  });
}

async function pollFolder() {
  if (!isAuthorized) {
    console.log('⚠ Not authorized. Skipping poll.');
    return;
  }

  try {
    console.log(`🔄 Polling folders...`);
    const newFiles = await listFiles();
    const changes = detectChanges(newFiles);

    if (changes.hasChanges) {
      console.log(`✓ Changes detected: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`);

      // Update file store with combined list
      fileStore = newFiles;

      // For added/modified files that are in the scan folder: start scans
      const toScan = [...changes.added, ...changes.modified].filter(f => f.source === 'scan');

      toScan.forEach(file => {
        const id = file.id;
        if (scanningJobs.has(id)) return;

        // initialize scanning
        scanStore[id] = { status: 'scanning', lastScannedAt: null };
        simulateScan(id, io).catch(err => {
          console.error('simulateScan error for', id, err && err.message);
          scanningJobs.delete(id);
        });
      });

      emitFileList({
        added: changes.added.length,
        modified: changes.modified.length,
        deleted: changes.deleted.length
      });
    } else {
      console.log('  No changes detected');
    }
  } catch (error) {
    console.error('❌ Poll error:', error && error.message ? error.message : error);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollFolder();
  pollTimer = setInterval(() => {
    pollFolder();
  }, POLL_INTERVAL);
  console.log(`✓ Polling started (every ${POLL_INTERVAL / 1000}s)`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('✓ Polling stopped');
  }
}

app.use(express.static('public'));

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Authorization code not found');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    isAuthorized = true;
    startPolling();
    res.send(`<html><body style="font-family:system-ui,Segoe UI,Roboto"><h1>Authorization Successful</h1><p>You can close this window and return to the app.</p><button onclick="window.close()|| (location.href='/')">Return</button></body></html>`);
  } catch (error) {
    console.error('Error getting tokens:', error.message);
    res.status(500).send('Error during authorization: ' + error.message);
  }
});

/**
 * Update Google Sheet with file rows:
 * Header: MD5 | Name | Size | Type | Time | Status
 * Overwrites from A1 downward.
 */
async function updateSheetFromFiles(files) {
  if (!SHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // Sort by modifiedTime desc
    const sorted = (files || []).slice().sort((a, b) => {
      const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
      const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
      return tb - ta;
    });

    // Build rows
    const rows = [];
    // header
    rows.push(['MD5', 'Name', 'Size', 'Type', 'Time', 'Status']);

    for (const f of sorted) {
      const md5 = f.md5Checksum || '-';
      const name = f.name || '';
      const size = f.size || '-';
      const type = (f.mimeType && f.mimeType.split('/')[1]) ? f.mimeType.split('/')[1].toUpperCase() : (f.mimeType || 'Unknown');
      const time = f.modifiedTime || '';
      const status = f.scanStatus || (f.source === 'quarantine' ? 'infected' : 'pending');
      rows.push([md5, name, size, type, time, status]);
    }

    const resource = { values: rows };

    // Write starting at A1
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'A1',
      valueInputOption: 'RAW',
      resource
    });

    console.log('✓ Sheet updated with current file list');
  } catch (err) {
    // bubble up so caller logs and notifies
    throw err;
  }
}

app.get('/api/files', (req, res) => {
  res.json({
    files: filesForClients(),
    authorized: isAuthorized,
    timestamp: new Date().toISOString(),
    folders: {
      scanFolderId: SCAN_FOLDER_ID,
      quarantineFolderId: QUARANTINE_FOLDER_ID
    }
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    authorized: isAuthorized,
    polling: pollTimer !== null,
    fileCount: fileStore.length,
    pollInterval: POLL_INTERVAL,
    scanFolderId: SCAN_FOLDER_ID,
    quarantineFolderId: QUARANTINE_FOLDER_ID
  });
});

io.on('connection', (socket) => {
  console.log('✓ Client connected:', socket.id);

  // send current list immediately
  emitFileList({ added: 0, modified: 0, deleted: 0 });

  socket.on('rescan_file', (data) => {
    const fileId = data && data.fileId;
    if (!fileId) return;

    console.log('📋 Rescan requested for file:', fileId);

    // allow rescans for files in either folder
    if (!scanningJobs.has(fileId)) {
      scanStore[fileId] = { status: 'scanning', lastScannedAt: null };
      emitFileList({ added: 0, modified: 0, deleted: 0 });
      simulateScan(fileId, io).catch(err => {
        console.error('simulateScan error for rescan', fileId, err && err.message);
        scanningJobs.delete(fileId);
      });
    } else {
      // already scanning
      scanStore[fileId] = { status: 'scanning', lastScannedAt: null };
      emitFileList({ added: 0, modified: 0, deleted: 0 });
    }
  });

  socket.on('move_file', async (data) => {
    const fileId = data && data.fileId;
    const targetFolderId = data && data.targetFolderId;
    if (!fileId || !targetFolderId) {
      socket.emit('move_failed', { fileId, error: 'Missing fileId or targetFolderId' });
      return;
    }
    if (!isAuthorized) {
      socket.emit('move_failed', { fileId, error: 'Not authorized' });
      return;
    }

    console.log(`📦 Move requested for file ${fileId} -> folder ${targetFolderId}`);
    const result = await moveFileById(fileId, targetFolderId);
    if (result.success) {
      io.emit('file_moved', { fileId, targetFolderId, timestamp: new Date().toISOString(), unchanged: result.unchanged || false });
      emitFileList({ added: 0, modified: 0, deleted: 0 });
    } else {
      socket.emit('move_failed', { fileId, error: result.error || 'Move failed' });
    }
  });

  socket.on('delete_file', async (data) => {
    const fileId = data && data.fileId;
    if (!fileId) return;
    if (!isAuthorized) {
      socket.emit('delete_failed', { fileId, error: 'Not authorized' });
      return;
    }

    try {
      // Use Drive API to delete (or move to trash). Here we permanently delete.
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      await drive.files.delete({ fileId });
      // remove locally
      fileStore = fileStore.filter(f => f.id !== fileId);
      delete scanStore[fileId];
      scanningJobs.delete(fileId);
      io.emit('file_deleted', { fileId, timestamp: new Date().toISOString() });
      emitFileList({ added: 0, modified: 0, deleted: 1 });
    } catch (err) {
      console.error('Delete failed:', err && err.message ? err.message : err);
      socket.emit('delete_failed', { fileId, error: err && err.message ? err.message : String(err) });
    }
  });

  socket.on('disconnect', () => {
    console.log('✗ Client disconnected:', socket.id);
  });
});

loadTokens();
if (isAuthorized) startPolling();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Scan folder: ${SCAN_FOLDER_ID}`);
  console.log(`Quarantine folder: ${QUARANTINE_FOLDER_ID || 'NOT SET'}`);
  console.log(`Sheet ID: ${SHEET_ID || 'NOT SET'}`);
  if (!isAuthorized) {
    console.log(`Visit http://localhost:${PORT}/auth to authorize (and grant Drive & Sheets scopes)`);
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopPolling();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  stopPolling();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
