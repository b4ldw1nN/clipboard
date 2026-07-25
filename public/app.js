document.addEventListener('DOMContentLoaded', () => {
    let authToken = localStorage.getItem('clipboard_token');
    let socket;
    let isTyping = false;
    let typingTimeout;
    let remoteTypingTimeout;

    // Persistent unique Device ID
    let deviceId = localStorage.getItem('clipboard_device_id');
    if (!deviceId) {
        deviceId = 'Dev-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('clipboard_device_id', deviceId);
    }

    const loginOverlay = document.getElementById('login-overlay');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password-input');
    const loginError = document.getElementById('login-error');

    // Live Clipboard Elements
    const clipboardText = document.getElementById('clipboard-text');
    const lastUpdated = document.getElementById('last-updated');
    const btnCopyLive = document.getElementById('btn-copy-live');
    const btnClearLive = document.getElementById('btn-clear-live');
    const btnSendToChat = document.getElementById('btn-send-to-chat');

    // File Upload Elements
    const btnUpload = document.getElementById('btn-upload');
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const fileList = document.getElementById('file-list');

    // Chat Stream Elements
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const btnSendChat = document.getElementById('btn-send-chat');
    const btnClearChat = document.getElementById('btn-clear-chat');

    // Header Badges
    const deviceIdText = document.getElementById('device-id-text');
    const typingIndicator = document.getElementById('typing-indicator');

    if (deviceIdText) deviceIdText.textContent = `${deviceId}`;

    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function timeAgo(dateStr) {
        if (!dateStr) return 'Ready';
        const seconds = Math.floor((new Date() - new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'))) / 1000);
        if (isNaN(seconds) || seconds < 5) return 'Just now';
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    function showToast(message, isError = false) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${isError ? 'error' : ''}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.2s, transform 0.2s';
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(30px)';
            setTimeout(() => toast.remove(), 200);
        }, 3000);
    }

    function showApp() { appContainer.classList.remove('hidden'); }

    async function initApp() {
        showApp(); connectSocket(); await loadInitialData();
        setInterval(updateTimestamps, 30000);
    }

    function updateTimestamps() {
        document.querySelectorAll('.file-time').forEach(el => el.textContent = timeAgo(el.dataset.time));
        document.querySelectorAll('.msg-time').forEach(el => el.textContent = timeAgo(el.dataset.time));
        if (lastUpdated && lastUpdated.dataset.time) {
            lastUpdated.textContent = `Synced ${timeAgo(lastUpdated.dataset.time)}`;
        }
    }

    function connectSocket() {
        if (socket) socket.disconnect();
        socket = io();

        socket.on('clipboard:update', (data) => {
            if (document.activeElement !== clipboardText || !isTyping) clipboardText.value = data.content;
            lastUpdated.dataset.time = data.updated_at;
            updateTimestamps();
        });

        socket.on('chat:message', (msg) => {
            addMessageToChat(msg);
        });

        socket.on('chat:cleared', () => {
            chatMessages.innerHTML = `
                <div class="chat-empty">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                    <p>No messages in stream</p>
                    <span>Messages sent from clipboard or typed below will appear here in real time.</span>
                </div>`;
            showToast('Chat history cleared');
        });

        socket.on('user:typing', () => {
            typingIndicator.classList.remove('hidden');
            clearTimeout(remoteTypingTimeout);
            remoteTypingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 1500);
        });

        socket.on('file:uploaded', (file) => { addFileToUI(file); showToast(`Uploaded: ${file.original_name}`); });
        
        socket.on('file:deleted', (data) => {
            const el = document.getElementById(`file-${data.id}`);
            if (el) { el.style.transition = 'all 0.2s ease'; el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 200); }
        });
    }

    async function loadInitialData() {
        try {
            // Fetch Clipboard Content
            const cRes = await fetch('/api/clipboard');
            const cData = await cRes.json();
            clipboardText.value = cData.content || '';
            lastUpdated.dataset.time = cData.updated_at;
            updateTimestamps();

            // Fetch Chat Stream Messages
            const mRes = await fetch('/api/messages');
            const mData = await mRes.json();
            chatMessages.innerHTML = '';
            if (!Array.isArray(mData) || mData.length === 0) {
                chatMessages.innerHTML = `
                    <div class="chat-empty">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                        <p>No messages in stream</p>
                        <span>Messages sent from clipboard or typed below will appear here in real time.</span>
                    </div>`;
            } else {
                mData.forEach(msg => addMessageToChat(msg, false));
                scrollToBottomChat();
            }

            // Fetch Files
            const fRes = await fetch('/api/files');
            (await fRes.json()).forEach((f, i) => setTimeout(() => addFileToUI(f), i * 30));

        } catch (err) { console.error(err); showToast('Failed to load workspace data', true); }
    }

    // --- Live Clipboard Actions ---
    clipboardText.addEventListener('input', () => {
        isTyping = true; clearTimeout(typingTimeout);
        if (socket?.connected) socket.emit('user:typing');
        
        typingTimeout = setTimeout(() => {
            isTyping = false; const content = clipboardText.value;
            if (socket?.connected) socket.emit('clipboard:update', { content });
            fetch('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }).catch(()=>{});
            lastUpdated.dataset.time = new Date().toISOString();
            updateTimestamps();
        }, 400);
    });

    btnCopyLive.addEventListener('click', () => copyTextToClipboard(clipboardText.value, btnCopyLive, 'Copy'));
    btnClearLive.addEventListener('click', () => {
        if (clipboardText.value) {
            clipboardText.value = '';
            clipboardText.dispatchEvent(new Event('input'));
            showToast('Live clipboard cleared');
        }
    });

    btnSendToChat.addEventListener('click', async () => {
        const text = clipboardText.value.trim();
        if (!text) return showToast('Clipboard is empty', true);
        await sendChatMessage(text);
        showToast('Sent to Chat Stream');
    });

    function copyTextToClipboard(text, btnElement, originalLabel) {
        if (!text) return showToast('Nothing to copy', true);
        navigator.clipboard.writeText(text).then(() => {
            showToast('Copied to clipboard');
            btnElement.textContent = 'Copied!';
            setTimeout(() => btnElement.textContent = originalLabel, 1500);
        }).catch(() => showToast('Failed to copy', true));
    }

    // --- Chat Stream Sender ---
    async function sendChatMessage(text) {
        if (!text) return;
        
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender_id: deviceId, text })
            });
            const data = await res.json();
            if (data.message) {
                addMessageToChat(data.message);
            }
        } catch (err) {
            console.error('Error sending message:', err);
            showToast('Failed to send message', true);
        }
    }

    btnSendChat.addEventListener('click', async () => {
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        await sendChatMessage(text);
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            btnSendChat.click();
        }
    });

    btnClearChat.addEventListener('click', async () => {
        try {
            await fetch('/api/messages', { method: 'DELETE' });
        } catch { showToast('Failed to clear chat stream', true); }
    });

    function addMessageToChat(msg, autoScroll = true) {
        if (!msg || !msg.id) return;

        // Prevent duplicate rendering
        if (document.getElementById(`msg-${msg.id}`)) return;

        const emptyState = chatMessages.querySelector('.chat-empty');
        if (emptyState) emptyState.remove();

        const isMine = msg.sender_id === deviceId;
        const bubble = document.createElement('div');
        bubble.className = `msg-bubble ${isMine ? 'is-mine' : 'is-other'}`;
        bubble.id = `msg-${msg.id}`;

        const senderLabel = isMine ? 'You' : msg.sender_id;

        bubble.innerHTML = `
            <div class="msg-meta">
                <span class="msg-sender">${senderLabel}</span>
                <span class="msg-time" data-time="${msg.created_at}">${timeAgo(msg.created_at)}</span>
            </div>
            <div class="msg-text"></div>
            <div class="msg-actions">
                <button class="btn-msg-action btn-copy-msg">Copy</button>
            </div>
        `;

        bubble.querySelector('.msg-text').textContent = msg.text;

        bubble.querySelector('.btn-copy-msg').addEventListener('click', function() {
            navigator.clipboard.writeText(msg.text).then(() => {
                showToast('Message copied');
                this.textContent = 'Copied!';
                setTimeout(() => this.textContent = 'Copy', 1500);
            });
        });

        chatMessages.appendChild(bubble);
        if (autoScroll) scrollToBottomChat();
    }

    function scrollToBottomChat() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // --- File Upload ---
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) { uploadFile(e.target.files[0]); fileInput.value = ''; } });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => { dropZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false); document.body.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false); });
    ['dragenter', 'dragover'].forEach(e => dropZone.addEventListener(e, () => dropZone.classList.add('dragover'), false));
    ['dragleave', 'drop'].forEach(e => dropZone.addEventListener(e, () => dropZone.classList.remove('dragover'), false));
    dropZone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]); }, false);

    document.addEventListener('paste', (e) => {
        if (document.activeElement === clipboardText || document.activeElement === chatInput) {
            return;
        }
        const items = e.clipboardData?.items; if (!items) return;
        for (let i = 0; i < items.length; i++) { if (items[i].type.indexOf('image') !== -1 || items[i].kind === 'file') { e.preventDefault(); const f = items[i].getAsFile(); if (f) uploadFile(f); break; } }
    }, false);

    async function uploadFile(file) {
        const fd = new FormData(); fd.append('file', file);
        btnUpload.textContent = 'Uploading...'; btnUpload.disabled = true;
        try {
            const res = await fetch('/api/upload', { method: 'POST', headers: getAuthHeaders(), body: fd });
            if (res.status === 401) return handleUnauthorized();
            if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
        } catch (err) { showToast(err.message, true); } 
        finally { btnUpload.textContent = 'Upload File'; btnUpload.disabled = false; }
    }

    function addFileToUI(file) {
        if (document.getElementById(`file-${file.id}`)) return;
        const div = document.createElement('div'); div.className = 'file-item'; div.id = `file-${file.id}`;
        div.innerHTML = `
            <div class="file-meta-info">
                <div class="file-name-text" title="${file.original_name}">${file.original_name}</div>
                <div class="file-details"><span>${formatBytes(file.size)}</span><span class="file-time" data-time="${file.uploaded_at}">${timeAgo(file.uploaded_at)}</span></div>
            </div>
            <div class="file-btns">
                <button class="btn btn-secondary btn-xs btn-download">Download</button>
                <button class="btn btn-ghost-danger btn-xs btn-delete">Delete</button>
            </div>`;

        div.querySelector('.btn-download').addEventListener('click', function() {
            this.textContent = '...';
            fetch(`/download/${file.id}`, { headers: getAuthHeaders() }).then(r => { if (r.status === 401) handleUnauthorized(); return r.blob(); }).then(blob => {
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.original_name; document.body.appendChild(a); a.click(); a.remove();
                this.textContent = 'Done';
                setTimeout(() => this.textContent = 'Download', 1500);
            }).catch(() => showToast('Download failed', true));
        });

        div.querySelector('.btn-delete').addEventListener('click', async function() {
            this.textContent = '...';
            try { const r = await fetch(`/api/file/${file.id}`, { method: 'DELETE', headers: getAuthHeaders() }); if (r.status === 401) handleUnauthorized(); if (!r.ok) throw new Error(); } 
            catch { showToast('Delete failed', true); this.textContent = 'Delete'; }
        });

        fileList.prepend(div);
    }

    (async function boot() {
        initApp();
    })();
});
