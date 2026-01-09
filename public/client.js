// client.js - combined view (replace existing client.js with this)

const socket = io();

let allFiles = [];
let searchTerm = '';
let filterStatus = 'all';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fileCount = document.getElementById('fileCount');
const lastUpdate = document.getElementById('lastUpdate');
const fileTableBody = document.getElementById('fileTableBody');
const searchBox = document.getElementById('searchBox');
const authNotice = document.getElementById('authNotice');
const filterSelect = document.getElementById('filterSelect');

// No folderSelect — we show files from both folders together

socket.on('connect', () => {
  console.log('Connected to server');
  updateStatus(true);
  checkAuthorization();
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  updateStatus(false);
});

socket.on('file_list', (data) => {
  console.log('Received file list:', data);
  // ensure it's an array
  allFiles = Array.isArray(data.files) ? data.files : [];

  // Defensive: ensure each file has a source (fallback logic)
  allFiles = allFiles.map(f => {
    const file = Object.assign({}, f);
    if (!file.source) {
      const status = (file.scanStatus || '').toLowerCase();
      file.source = status === 'infected' ? 'quarantine' : 'scan';
    }
    return file;
  });

  renderFiles();
  updateStats(data);
});

socket.on('scan_complete', (data) => {
  console.log('Scan complete:', data);
  const fileIndex = allFiles.findIndex(f => f.id === data.fileId);
  if (fileIndex !== -1) {
    allFiles[fileIndex].scanStatus = data.status;
    allFiles[fileIndex].lastScannedAt = data.timestamp;
    // if infected, consider it quarantined for UI (so actions change)
    if ((data.status || '').toLowerCase() === 'infected') {
      allFiles[fileIndex].source = 'quarantine';
    }
    renderFiles();
  } else {
    renderFiles();
  }
});

socket.on('file_moved', (data) => {
  console.log('File moved:', data);
  // server will re-emit file_list; for snappy UI remove moved file if server moved out
  if (data && data.fileId) {
    allFiles = allFiles.filter(f => f.id !== data.fileId);
    renderFiles();
  }
});

socket.on('file_deleted', (data) => {
  console.log('File deleted:', data);
  if (data && data.fileId) {
    allFiles = allFiles.filter(f => f.id !== data.fileId);
    renderFiles();
  }
});

socket.on('delete_failed', (data) => {
  console.error('Delete failed:', data);
  alert(`Failed to delete file: ${data && data.error ? data.error : 'Unknown error'}`);
});

socket.on('move_failed', (data) => {
  console.error('Move failed:', data);
  alert(`Failed to move file: ${data && data.error ? data.error : 'Unknown error'}`);
});

socket.on('scan_alert', (data) => {
  console.warn('Scan alert from server:', data);
  // small alert for now
  alert(`Scan alert: ${data && data.error ? data.error : 'Unknown error'}`);
});

searchBox.addEventListener('input', (e) => {
  searchTerm = e.target.value.toLowerCase();
  renderFiles();
});

if (filterSelect) {
  filterSelect.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    renderFiles();
  });
}

function updateStatus(connected) {
  if (connected) {
    statusDot.classList.remove('disconnected');
    statusText.textContent = 'Connected';
  } else {
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Disconnected';
  }
}

async function checkAuthorization() {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    if (!data.authorized) {
      authNotice.style.display = 'block';
    } else {
      authNotice.style.display = 'none';
    }
  } catch (error) {
    console.error('Error checking authorization:', error);
  }
}

function updateStats(data) {
  // total count from both folders
  const total = allFiles.length;
  fileCount.textContent = `${total} file${total !== 1 ? 's' : ''}`;

  if (data && data.timestamp) {
    const updateTime = new Date(data.timestamp);
    lastUpdate.textContent = `Updated ${formatTimeAgo(updateTime)}`;
  }
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === '0') return '-';
  const num = parseInt(bytes, 10);
  if (Number.isNaN(num)) return '-';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (isNaN(date)) return '-';
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return `Today ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays === 1) {
    return `Yesterday ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function getFileIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType.includes('folder')) return '📁';
  if (mimeType.includes('image')) return '🖼️';
  if (mimeType.includes('video')) return '🎥';
  if (mimeType.includes('audio')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('compressed')) return '📦';
  if (mimeType.includes('text')) return '📄';
  return '📎';
}

function getFileType(mimeType) {
  if (!mimeType) return 'Unknown';
  const parts = mimeType.split('/');
  if (parts.length < 2) return mimeType;
  const subtype = parts[1].split('.').pop();
  return subtype.toUpperCase();
}

function renderFiles() {
  // Apply search filter across all files
  const filteredBySearch = allFiles.filter(file =>
    (file.name || '').toLowerCase().includes(searchTerm)
  );

  // Apply status filter
  const filteredByStatus = filteredBySearch.filter(file => {
    if (filterStatus === 'all') return true;
    return (file.scanStatus || '').toLowerCase() === filterStatus;
  });

  // Sort by modifiedTime desc (newest first). Files without modifiedTime go last.
  const sorted = filteredByStatus.slice().sort((a, b) => {
    const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
    const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
    return tb - ta;
  });

  if (sorted.length === 0) {
    fileTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <p>${searchTerm ? 'No files match your search' : 'No files available'}</p>
        </td>
      </tr>
    `;
    return;
  }

  fileTableBody.innerHTML = sorted.map(file => {
    // Build actions based on status and source
    let actionsHtml = '';
    const escapedName = escapeHtml(file.name || '');

    // If the file is quarantined or infected -> Quarantined (non-clickable), Delete, Rescan
    if (file.source === 'quarantine' || (file.scanStatus || '').toLowerCase() === 'infected') {
      actionsHtml = `
        <div class="actions">
          <span class="btn btn-small btn-secondary" style="opacity:0.6; cursor:default;">Quarantined</span>
          <button class="btn btn-small btn" onclick="confirmAndDelete('${file.id}', '${escapedName}')">Delete</button>
          <button class="btn btn-small btn-secondary" onclick="rescanFile('${file.id}')">Rescan</button>
        </div>
      `;
    } else {
      // Non-quarantine: View (if available), Delete, Rescan
      actionsHtml = `
        <div class="actions">
          ${file.webViewLink ? `<a href="${file.webViewLink}" target="_blank" class="btn btn-small btn-secondary">View</a>` : ''}
          <button class="btn btn-small btn" onclick="confirmAndDelete('${file.id}', '${escapedName}')">Delete</button>
          <button class="btn btn-small btn-secondary" onclick="rescanFile('${file.id}')">Rescan</button>
        </div>
      `;
    }

    return `
      <tr data-file-id="${file.id}">
        <td><span class="badge ${file.scanStatus}">${file.scanStatus}</span></td>
        <td>
          <div class="file-name">
            <span class="file-icon">${getFileIcon(file.mimeType)}</span>
            <span>${escapedName}</span>
          </div>
        </td>
        <td>${getFileType(file.mimeType)}</td>
        <td class="file-size">${formatFileSize(file.size)}</td>
        <td>${formatDate(file.modifiedTime)}</td>
        <td>${actionsHtml}</td>
      </tr>
    `;
  }).join('');
}

function rescanFile(fileId) {
  console.log('Requesting rescan for file:', fileId);
  socket.emit('rescan_file', { fileId });

  const fileIndex = allFiles.findIndex(f => f.id === fileId);
  if (fileIndex !== -1) {
    allFiles[fileIndex].scanStatus = 'scanning';
    renderFiles();
  }
}

function confirmAndDelete(fileId, fileNameEscaped) {
  const tmp = document.createElement('div');
  tmp.innerHTML = fileNameEscaped;
  const fileName = tmp.textContent || tmp.innerText || fileNameEscaped;

  const ok = confirm(`Are you sure you want to permanently delete "${fileName}"? This cannot be undone.`);
  if (!ok) return;

  const idx = allFiles.findIndex(f => f.id === fileId);
  if (idx !== -1) {
    allFiles[idx].scanStatus = 'pending';
    renderFiles();
  }

  socket.emit('delete_file', { fileId });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// expose functions for inline onclicks
window.rescanFile = rescanFile;
window.confirmAndDelete = confirmAndDelete;
