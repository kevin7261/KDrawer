import { computed, onMounted, onUnmounted, reactive } from 'vue'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const GOOGLE_ACCOUNTS_SCRIPT = 'https://accounts.google.com/gsi/client'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FOLDER_NAME = 'KDrawer'
const DRIVE_FILE_NAME = 'kdrawer-session.json'
const CONNECTED_KEY = 'kdrawer-google-drive-connected'
const POLL_INTERVAL_MS = 30000
const UPLOAD_DEBOUNCE_MS = 1800

function waitForGoogleAccountsScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GOOGLE_ACCOUNTS_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Google Identity Services 載入失敗')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_ACCOUNTS_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Identity Services 載入失敗'))
    document.head.appendChild(script)
  })
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function getPayloadUpdatedAt(payload) {
  const value = payload?.updatedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function useGoogleDriveSync({
  getPayload,
  applyPayload,
  onLocalChange,
  showConfirm,
  showToast,
}) {
  let tokenClient = null
  let accessToken = ''
  let folderId = ''
  let fileId = ''
  let lastRemoteUpdatedAt = 0
  let uploadTimer = null
  let pollTimer = null
  let unsubscribeLocalChange = null
  let isApplyingRemote = false

  const state = reactive({
    configured: Boolean(GOOGLE_CLIENT_ID),
    signedIn: false,
    busy: false,
    status: GOOGLE_CLIENT_ID ? '未登入 Google Drive' : '尚未設定 Google Drive',
    lastSyncedAt: null,
  })

  const statusLabel = computed(() => {
    if (!state.configured) return '雲端未設定'
    if (state.busy) return state.status
    if (!state.signedIn) return '雲端未登入'
    if (state.lastSyncedAt) return '已同步 ' + state.lastSyncedAt.toLocaleTimeString()
    return state.status
  })

  function setBusy(status) {
    state.busy = true
    state.status = status
  }

  function setIdle(status) {
    state.busy = false
    state.status = status
  }

  async function initTokenClient() {
    if (!state.configured) throw new Error('尚未設定 VITE_GOOGLE_CLIENT_ID')
    if (tokenClient) return tokenClient
    await waitForGoogleAccountsScript()
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {},
    })
    return tokenClient
  }

  async function requestAccessToken(prompt = 'consent') {
    const client = await initTokenClient()
    return new Promise((resolve, reject) => {
      client.callback = response => {
        if (response?.error) {
          reject(new Error(response.error))
          return
        }
        accessToken = response.access_token || ''
        state.signedIn = Boolean(accessToken)
        if (!accessToken) {
          reject(new Error('沒有取得 Google 授權權杖'))
          return
        }
        try { localStorage.setItem(CONNECTED_KEY, '1') } catch (_) {}
        resolve(accessToken)
      }
      client.requestAccessToken({ prompt })
    })
  }

  async function ensureAccessToken(prompt = '') {
    if (accessToken) return accessToken
    return requestAccessToken(prompt)
  }

  async function driveFetch(path, options = {}) {
    await ensureAccessToken('')
    const headers = new Headers(options.headers || {})
    headers.set('Authorization', `Bearer ${accessToken}`)
    const response = await fetch(path, { ...options, headers })
    if (response.status === 401) {
      accessToken = ''
      state.signedIn = false
    }
    if (!response.ok) {
      let message = response.statusText
      try {
        const body = await response.json()
        message = body?.error?.message || message
      } catch (_) {}
      throw new Error(message || 'Google Drive API 失敗')
    }
    return response
  }

  async function driveJson(path, options) {
    const response = await driveFetch(path, options)
    return response.json()
  }

  async function findDriveFolder() {
    const params = new URLSearchParams({
      q: `name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: '1',
    })
    const result = await driveJson(`${DRIVE_API_BASE}/files?${params}`)
    return result.files?.[0] || null
  }

  async function createDriveFolder() {
    return driveJson(`${DRIVE_API_BASE}/files?fields=id,name,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    })
  }

  async function ensureDriveFolder() {
    if (folderId) return folderId
    const existing = await findDriveFolder()
    const folder = existing || await createDriveFolder()
    folderId = folder.id
    return folderId
  }

  async function findSessionFile(parentFolderId) {
    const params = new URLSearchParams({
      q: `name='${escapeDriveQueryValue(DRIVE_FILE_NAME)}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: '1',
    })
    const result = await driveJson(`${DRIVE_API_BASE}/files?${params}`)
    return result.files?.[0] || null
  }

  async function ensureSessionFile() {
    const parentFolderId = await ensureDriveFolder()
    if (fileId) return fileId
    const existing = await findSessionFile(parentFolderId)
    if (existing) {
      fileId = existing.id
      return fileId
    }
    return ''
  }

  function createMultipartBody(metadata, payload) {
    const boundary = 'kdrawer_' + Math.random().toString(36).slice(2)
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(payload),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    return {
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    }
  }

  async function uploadPayload(payload) {
    const parentFolderId = await ensureDriveFolder()
    await ensureSessionFile()
    const metadata = {
      name: DRIVE_FILE_NAME,
      mimeType: 'application/json',
      ...(fileId ? {} : { parents: [parentFolderId] }),
    }
    const multipart = createMultipartBody(metadata, payload)
    const url = fileId
      ? `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=multipart&fields=id,name,modifiedTime`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime`
    const result = await driveJson(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body,
    })
    fileId = result.id
    lastRemoteUpdatedAt = getPayloadUpdatedAt(payload)
    state.lastSyncedAt = new Date()
    return result
  }

  async function downloadPayload() {
    const remoteFileId = await ensureSessionFile()
    if (!remoteFileId) return null
    const response = await driveFetch(`${DRIVE_API_BASE}/files/${remoteFileId}?alt=media`, {
      headers: { Accept: 'application/json' },
    })
    const payload = await response.json()
    lastRemoteUpdatedAt = getPayloadUpdatedAt(payload)
    return payload
  }

  async function pullIfRemoteIsNewer({ initial = false } = {}) {
    const remote = await downloadPayload()
    if (!remote) return false
    const local = getPayload()
    const remoteUpdatedAt = getPayloadUpdatedAt(remote)
    const localUpdatedAt = getPayloadUpdatedAt(local)
    if (!initial && remoteUpdatedAt <= localUpdatedAt) return false

    let ok = true
    if (!initial && remoteUpdatedAt > localUpdatedAt && typeof showConfirm === 'function') {
      ok = await showConfirm('Google Drive 上有較新的 KDrawer 內容，要套用雲端版本嗎？')
    }
    if (!ok) return false

    isApplyingRemote = true
    try {
      await applyPayload(remote)
      lastRemoteUpdatedAt = remoteUpdatedAt
      state.lastSyncedAt = new Date()
      return true
    } finally {
      isApplyingRemote = false
    }
  }

  async function pushLocalPayload() {
    const payload = getPayload()
    await uploadPayload(payload)
  }

  function scheduleUpload() {
    if (!state.signedIn || isApplyingRemote) return
    if (uploadTimer) clearTimeout(uploadTimer)
    uploadTimer = setTimeout(() => {
      uploadTimer = null
      void syncNow({ quiet: true, preferUpload: true })
    }, UPLOAD_DEBOUNCE_MS)
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      if (!state.signedIn || state.busy) return
      void pullIfRemoteIsNewer().catch(() => {})
    }, POLL_INTERVAL_MS)
  }

  async function syncNow({ quiet = false, preferUpload = false } = {}) {
    if (!state.configured) {
      showToast?.('請先設定 VITE_GOOGLE_CLIENT_ID')
      return
    }
    setBusy('同步 Google Drive 中…')
    try {
      await ensureAccessToken('consent')
      const remote = await downloadPayload()
      if (!remote) {
        await pushLocalPayload()
      } else {
        const local = getPayload()
        const remoteUpdatedAt = getPayloadUpdatedAt(remote)
        const localUpdatedAt = getPayloadUpdatedAt(local)
        if (remoteUpdatedAt > localUpdatedAt && !preferUpload) {
          isApplyingRemote = true
          try { await applyPayload(remote) } finally { isApplyingRemote = false }
          lastRemoteUpdatedAt = remoteUpdatedAt
        } else if (localUpdatedAt > lastRemoteUpdatedAt || preferUpload) {
          await uploadPayload(local)
        }
      }
      state.lastSyncedAt = new Date()
      startPolling()
      setIdle('Google Drive 已同步')
      if (!quiet) showToast?.('已同步到 Google Drive 的 KDrawer 資料夾')
    } catch (error) {
      setIdle('同步失敗')
      if (!quiet) showToast?.('Google Drive 同步失敗：' + (error?.message || '未知錯誤'))
    }
  }

  async function signIn() {
    if (!state.configured) {
      showToast?.('請在專案根目錄建立 .env，加入一行 VITE_GOOGLE_CLIENT_ID=你的 OAuth 用戶端 ID，存檔後重新執行 npm run dev（可參考 .env.example）')
      return
    }
    setBusy('等待 Google 授權…')
    try {
      await requestAccessToken('consent')
      await syncNow()
    } catch (error) {
      setIdle('登入失敗')
      showToast?.('Google Drive 登入失敗：' + (error?.message || '未知錯誤'))
    }
  }

  async function signOut() {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {})
    }
    accessToken = ''
    state.signedIn = false
    folderId = ''
    fileId = ''
    lastRemoteUpdatedAt = 0
    try { localStorage.removeItem(CONNECTED_KEY) } catch (_) {}
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    setIdle('已登出 Google Drive')
    showToast?.('已登出 Google Drive，改為本機模式')
  }

  onMounted(() => {
    unsubscribeLocalChange = onLocalChange?.(() => scheduleUpload()) || null
    let shouldReconnect = false
    try { shouldReconnect = localStorage.getItem(CONNECTED_KEY) === '1' } catch (_) {}
    if (state.configured && shouldReconnect) {
      void (async () => {
        try {
          setBusy('重新連線 Google Drive…')
          await requestAccessToken('')
          await syncNow({ quiet: true })
        } catch (_) {
          setIdle('需要重新登入')
        }
      })()
    }
  })

  onUnmounted(() => {
    if (uploadTimer) clearTimeout(uploadTimer)
    if (pollTimer) clearInterval(pollTimer)
    unsubscribeLocalChange?.()
  })

  return {
    state,
    statusLabel,
    signIn,
    signOut,
    syncNow,
  }
}
