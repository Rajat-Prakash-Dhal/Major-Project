# Google Drive Folder Monitor

A production-ready web application that monitors a specific Google Drive folder and displays real-time updates of files using polling. The app automatically detects new files, modifications, and deletions, broadcasting updates to all connected clients via WebSockets.

## Features

- **Real-time Monitoring**: Polls Google Drive folder every 15 seconds for changes
- **Live Updates**: WebSocket-based live updates to all connected clients
- **File Management**: View, download, and track file status
- **Search Functionality**: Filter files by name in real-time
- **Scan Ready**: Includes hooks for integrating virus scanning (ClamAV/VirusTotal)
- **Responsive UI**: Clean, modern interface that works on all devices
- **OAuth2 Authentication**: Secure Google Drive API access
- **Docker Support**: Ready for containerized deployment

## Architecture

### Polling Mechanism

The application uses a simple polling strategy:

1. **Interval**: Every 15 seconds (configurable via `POLL_INTERVAL_MS`)
2. **Query**: Uses Google Drive API `files.list` with filter `'FOLDER_ID' in parents and trashed = false`
3. **Change Detection**: Compares currenith previous state to t file list wdetect:
   - New files (added)
   - Modified files (based on `modifiedTime`)
   - Deleted files (no longer present)
4. **Broadcast**: On changes, emits `file_list` event via Socket.IO to all connected clients
5. **No Push**: Does NOT use webhooks, push notifications, or Pub/Sub

### Tech Stack

**Backend**:
- Node.js + Express
- Socket.IO (WebSocket communication)
- Google Drive API v3 (OAuth2)
- In-memory file storage

**Frontend**:
- Vanilla HTML/CSS/JavaScript
- Socket.IO client
- Responsive design

## Prerequisites

1. **Node.js**: Version 16 or higher
2. **Google Cloud Console Account**: For OAuth2 credentials
3. **Google Drive Access**: Permission to access the target folder

## Setup Instructions

### 1. Create Google OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** → **Credentials**
4. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
5. Configure the OAuth consent screen if prompted:
   - User Type: External (for testing) or Internal (for organization)
   - Add app name, user support email, and developer contact
   - Scopes: Add `https://www.googleapis.com/auth/drive.readonly`
   - Add test users (if external)
6. Create OAuth Client ID:
   - Application type: **Web application**
   - Name: `Google Drive Monitor`
   - Authorized redirect URIs: `http://localhost:3000/oauth2callback`
   - Click **CREATE**
7. Copy your **Client ID** and **Client Secret**
8. Enable the **Google Drive API**:
   - Navigate to **APIs & Services** → **Library**
   - Search for "Google Drive API"
   - Click **ENABLE**

### 2. Install and Configure

Clone and setup:

```bash
git clone <repository-url>
cd gdrive-folder-monitor

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

Edit `.env` with your credentials:

```env
GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
GOOGLE_FOLDER_ID=1MjQ0vDxUyLRXRDOnmGlEqyH7TjYV2w1m
PORT=3000
POLL_INTERVAL_MS=15000
```

### 3. Run the Application

```bash
npm start
```

The server will start on `http://localhost:3000`

### 4. Authorize the Application

1. Open `http://localhost:3000` in your browser
2. You'll see an authorization notice
3. Click **"Authorize with Google"**
4. Sign in with your Google account
5. Grant permissions to read your Google Drive files
6. You'll be redirected back and polling will start automatically

## Usage

### Monitoring Files

Once authorized, the app will:
- Automatically poll the configured folder every 15 seconds
- Display all files in a table with:
  - Scan status badge (pending/scanning/clean/infected)
  - Filename with icon
  - File type
  - File size
  - Last modified date
  - Action buttons (View, Download, Rescan)

### Search

Use the search box to filter files by name in real-time.

### Rescan Files

Click the "Rescan" button on any file to trigger a scan. Currently, this emits a socket event that you can use to integrate with:
- **ClamAV**: Antivirus scanner
- **VirusTotal API**: Online malware detection
- Custom scanning solution

## API Endpoints

### `GET /auth`
Initiates OAuth2 flow, redirects to Google consent screen.

### `GET /oauth2callback`
OAuth2 callback endpoint, stores tokens and starts polling.

### `GET /api/files`
Returns current file list in JSON format:

```json
{
  "files": [
    {
      "id": "file_id",
      "name": "document.pdf",
      "mimeType": "application/pdf",
      "size": "1234567",
      "modifiedTime": "2025-01-01T12:00:00.000Z",
      "webViewLink": "https://drive.google.com/...",
      "webContentLink": "https://drive.google.com/...",
      "scanStatus": "pending",
      "lastScannedAt": null
    }
  ],
  "authorized": true,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### `GET /api/status`
Returns server status:

```json
{
  "authorized": true,
  "polling": true,
  "fileCount": 42,
  "pollInterval": 15000,
  "folderId": "1MjQ0vDxUyLRXRDOnmGlEqyH7TjYV2w1m"
}
```

## WebSocket Events

### Client → Server

**`rescan_file`**: Request file rescan
```javascript
socket.emit('rescan_file', { fileId: 'file_id_here' });
```

### Server → Client

**`file_list`**: Updated file list
```javascript
socket.on('file_list', (data) => {
  // data.files: array of file objects
  // data.timestamp: ISO timestamp
  // data.changes: { added, modified, deleted }
});
```

**`scan_status`**: Scan status update
```javascript
socket.on('scan_status', (data) => {
  // data.fileId: file identifier
  // data.status: 'scanning' | 'clean' | 'infected'
  // data.message: status message
});
```

## Integrating File Scanning

The app includes hooks for file scanning. To implement:

### Option 1: ClamAV

```javascript
const { NodeClam } = require('clamscan');

const ClamScan = new NodeClam().init();

async function scanFile(fileId, filePath) {
  const { isInfected, viruses } = await ClamScan.scanFile(filePath);

  return {
    fileId,
    status: isInfected ? 'infected' : 'clean',
    viruses: viruses || []
  };
}
```

### Option 2: VirusTotal

```javascript
const FormData = require('form-data');

async function scanWithVirusTotal(fileId, filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const response = await fetch('https://www.virustotal.com/api/v3/files', {
    method: 'POST',
    headers: {
      'x-apikey': process.env.VIRUSTOTAL_API_KEY
    },
    body: form
  });

  const data = await response.json();
  // Process VirusTotal response
}
```

Add scanning logic in the `rescan_file` socket handler in `server.js`.

## Docker Deployment

Build and run with Docker:

```bash
# Build image
docker build -t gdrive-monitor .

# Run container
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/tokens.json:/app/tokens.json \
  --name gdrive-monitor \
  gdrive-monitor
```

Or use Docker Compose:

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./.env:/app/.env
      - ./tokens.json:/app/tokens.json
    restart: unless-stopped
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID | Required |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret | Required |
| `GOOGLE_REDIRECT_URI` | OAuth2 callback URL | Required |
| `GOOGLE_FOLDER_ID` | Drive folder to monitor | Required |
| `PORT` | Server port | 3000 |
| `POLL_INTERVAL_MS` | Polling interval (ms) | 15000 |

### Changing Poll Interval

To modify polling frequency, update `POLL_INTERVAL_MS` in `.env`:

```env
# Poll every 30 seconds
POLL_INTERVAL_MS=30000

# Poll every 5 seconds (aggressive)
POLL_INTERVAL_MS=5000
```

Note: Google Drive API has quota limits. Default 15 seconds is recommended.

## Project Structure

```
.
├── server.js              # Express server + Socket.IO + polling logic
├── public/
│   ├── index.html        # Frontend UI
│   └── client.js         # WebSocket client + UI logic
├── package.json          # Dependencies
├── .env.example          # Environment template
├── Dockerfile            # Container configuration
├── .dockerignore         # Docker ignore rules
├── README.md             # This file
└── tokens.json           # OAuth tokens (generated after auth)
```

## Troubleshooting

### "Not Authorized" Error

1. Ensure you've completed the OAuth flow via `/auth`
2. Check that `tokens.json` exists and is valid
3. Verify your OAuth credentials in `.env`

### No Files Showing

1. Confirm the folder ID is correct
2. Ensure your Google account has access to the folder
3. Check browser console for errors
4. Verify the folder contains files

### Polling Not Working

1. Check server logs for errors
2. Verify Google Drive API is enabled in Cloud Console
3. Ensure OAuth token has `drive.readonly` scope
4. Check API quota limits in Cloud Console

### Connection Issues

1. Ensure port 3000 is not in use
2. Check firewall settings
3. Verify WebSocket connections are not blocked

## API Rate Limits

Google Drive API quotas (free tier):
- **Queries per 100 seconds**: 1,000
- **Queries per day**: 1,000,000,000

With 15-second polling:
- 4 requests per minute
- 240 requests per hour
- 5,760 requests per day

Well within free tier limits.

## Security Notes

1. **OAuth Tokens**: Stored in `tokens.json` - keep secure
2. **Environment Variables**: Never commit `.env` to version control
3. **Scopes**: Uses `drive.readonly` - no write permissions
4. **File Downloads**: Links expire after time set by Google
5. **Production**: Use HTTPS and secure WebSocket connections (WSS)

## License

MIT

## Support

For issues or questions, please open an issue in the repository.
