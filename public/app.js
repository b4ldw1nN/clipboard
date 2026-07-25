document.addEventListener('DOMContentLoaded', () => {
    let socket = null;
    let currentRoomId = null;
    let isTyping = false;
    let typingTimeout = null;
    let remoteTypingTimeout = null;

    // Persistent Unique Session ID
    let sessionId = localStorage.getItem('clipboard_session_id');
    if (!sessionId) {
        sessionId = 'user_' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('clipboard_session_id', sessionId);
    }

    // Generate Fun Random Username (No "Anonymous")
    let username = localStorage.getItem('clipboard_random_name');
    if (!username) {
        const adjectives = ['Swift', 'Cosmic', 'Neon', 'Cyber', 'Solar', 'Lunar', 'Velvet', 'Shadow', 'Turbo', 'Pixel'];
        const nouns = ['Panda', 'Falcon', 'Phoenix', 'Viper', 'Otter', 'Lynx', 'Raven', 'Puma', 'Panther', 'Orbit'];
        const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const randNoun = nouns[Math.floor(Math.random() * nouns.length)];
        const randNum = Math.floor(100 + Math.random() * 900);
        username = `${randAdj}${randNoun}_${randNum}`;
        localStorage.setItem('clipboard_random_name', username);
    }

    // DOM Elements
    const roomModal = document.getElementById('room-modal');
    const btnCreateRoom = document.getElementById('btn-create-room');
    const joinRoomForm = document.getElementById('join-room-form');
    const inputRoomId = document.getElementById('input-room-id');
    const roomError = document.getElementById('room-error');
    
    const appContainer = document.getElementById('app-container');
    const currentRoomTag = document.getElementById('current-room-tag');
    const profileNameText = document.getElementById('profile-name-text');
    const btnShareLink = document.getElementById('btn-share-link');
    const btnCopyRoom = document.getElementById('btn-copy-room');
    const btnExportChat = document.getElementById('btn-export-chat');
    const btnClearAll = document.getElementById('btn-clear-all');
    const btnLeaveRoom = document.getElementById('btn-leave-room');

    const lightboxModal = document.getElementById('lightbox-modal');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxFilename = document.getElementById('lightbox-filename');
    const lightboxDownload = document.getElementById('lightbox-download');
    const btnCloseLightbox = document.getElementById('btn-close-lightbox');

    const dragOverlay = document.getElementById('drag-overlay');
    const chatStream = document.getElementById('chat-stream');
    const emptyState = document.getElementById('empty-state');
    
    const chatInput = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send');
    const btnAttach = document.getElementById('btn-attach');
    const fileInput = document.getElementById('file-input');

    const userCountText = document.getElementById('user-count-text');
    const typingIndicator = document.getElementById('typing-indicator');
    const typingUserText = document.getElementById('typing-user-text');

    if (profileNameText) profileNameText.textContent = username;

    // Utility Helpers
    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function showToast(message, isError = false) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${isError ? 'error' : ''}`;
        
        const iconSvg = isError
            ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
            : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
        
        toast.innerHTML = `${iconSvg}<span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.2s, transform 0.2s';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
            setTimeout(() => toast.remove(), 200);
        }, 2600);
    }

    // --- Room Creation & Joining Handlers ---
    btnCreateRoom.addEventListener('click', async () => {
        roomError.classList.add('hidden');
        try {
            const res = await fetch('/api/room/create', { method: 'POST' });
            const data = await res.json();
            if (data.success && data.room_id) {
                enterRoom(data.room_id);
            } else {
                showRoomError('Failed to create room.');
            }
        } catch (err) {
            showRoomError('Server error creating room.');
        }
    });

    joinRoomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        roomError.classList.add('hidden');
        const code = inputRoomId.value.trim().toLowerCase();
        if (!code) return;

        try {
            const res = await fetch('/api/room/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: code })
            });
            const data = await res.json();
            if (res.ok && data.room_id) {
                enterRoom(data.room_id);
            } else {
                showRoomError(data.error || 'Room not found.');
            }
        } catch (err) {
            showRoomError('Server error joining room.');
        }
    });

    function showRoomError(msg) {
        roomError.textContent = msg;
        roomError.classList.remove('hidden');
    }

    function enterRoom(roomId) {
        currentRoomId = roomId;
        window.location.hash = roomId;
        roomModal.classList.add('hidden');
        appContainer.classList.remove('hidden');
        currentRoomTag.textContent = roomId;

        connectSocket();
        loadChatHistory();
    }

    // Share Direct Room Link
    if (btnShareLink) {
        btnShareLink.addEventListener('click', () => {
            if (!currentRoomId) return;
            const fullUrl = `${window.location.origin}/#${currentRoomId}`;
            navigator.clipboard.writeText(fullUrl).then(() => {
                showToast('Direct Room Link copied to clipboard!');
            });
        });
    }

    const contextMenu = document.getElementById('context-menu');
    const ctxCopy = document.getElementById('ctx-copy');
    const ctxExport = document.getElementById('ctx-export');
    const ctxDelete = document.getElementById('ctx-delete');
    const ctxClearAll = document.getElementById('ctx-clear-all');

    let activeCtxTarget = null; // Store reference to target message wrapper

    // Helper functions for Export & Clear All
    async function triggerExportChat() {
        if (!currentRoomId) return;
        try {
            const res = await fetch(`/api/messages?room_id=${encodeURIComponent(currentRoomId)}`);
            if (!res.ok) throw new Error();
            const messages = await res.json();

            let md = `# Shared Clipboard History - Room: ${currentRoomId}\n\n`;
            md += `*Exported on ${new Date().toLocaleString()}*\n\n---\n\n`;

            messages.forEach(msg => {
                const time = new Date(msg.created_at).toLocaleString();
                if (msg.type === 'file') {
                    md += `**[${time}] ${msg.username}:** 📎 File Attachment: *${msg.original_name || msg.content}* (${formatBytes(msg.size)})\n\n`;
                } else {
                    md += `**[${time}] ${msg.username}:**\n\`\`\`\n${msg.content}\n\`\`\`\n\n`;
                }
            });

            const blob = new Blob([md], { type: 'text/markdown' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `clipboard_room_${currentRoomId}_history.md`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast('Room chat history exported!');
        } catch {
            showToast('Failed to export room history', true);
        }
    }

    async function triggerClearAll() {
        if (!currentRoomId) return;
        if (!confirm('Are you sure you want to clear all messages in this room?')) return;
        try {
            const res = await fetch(`/api/room/messages?room_id=${encodeURIComponent(currentRoomId)}`, { method: 'DELETE' });
            if (res.ok) {
                chatStream.innerHTML = '';
                showToast('All room messages cleared');
            } else {
                showToast('Failed to clear room', true);
            }
        } catch {
            showToast('Failed to clear room', true);
        }
    }

    // Context Menu Event Listeners
    document.addEventListener('click', () => {
        if (contextMenu) contextMenu.classList.add('hidden');
    });

    if (ctxCopy) {
        ctxCopy.addEventListener('click', () => {
            if (activeCtxTarget) {
                const txt = activeCtxTarget.dataset.content || '';
                if (txt) {
                    navigator.clipboard.writeText(txt).then(() => showToast('Text copied to clipboard!'));
                }
            }
        });
    }

    if (ctxExport) {
        ctxExport.addEventListener('click', triggerExportChat);
    }

    if (ctxClearAll) {
        ctxClearAll.addEventListener('click', triggerClearAll);
    }

    if (ctxDelete) {
        ctxDelete.addEventListener('click', async () => {
            if (activeCtxTarget && activeCtxTarget.dataset.msgId) {
                const msgId = activeCtxTarget.dataset.msgId;
                try {
                    const res = await fetch(`/api/messages/${msgId}`, { method: 'DELETE' });
                    if (res.ok) {
                        activeCtxTarget.style.transition = 'all 0.25s ease';
                        activeCtxTarget.style.opacity = '0';
                        activeCtxTarget.style.transform = 'translateY(10px)';
                        setTimeout(() => activeCtxTarget.remove(), 250);
                        showToast('Message deleted');
                    } else {
                        showToast('Failed to delete message', true);
                    }
                } catch {
                    showToast('Failed to delete message', true);
                }
            }
        });
    }

    // Lightbox Modal Handlers
    if (btnCloseLightbox) {
        btnCloseLightbox.addEventListener('click', () => lightboxModal.classList.add('hidden'));
    }
    if (lightboxModal) {
        lightboxModal.addEventListener('click', (e) => {
            if (e.target === lightboxModal) lightboxModal.classList.add('hidden');
        });
    }

    // Copy Room Code Button
    btnCopyRoom.addEventListener('click', () => {
        if (!currentRoomId) return;
        navigator.clipboard.writeText(currentRoomId).then(() => {
            showToast('Room Code copied to clipboard!');
        });
    });

    // Leave Room Handler
    if (btnLeaveRoom) {
        btnLeaveRoom.addEventListener('click', () => {
            if (socket) socket.disconnect();
            currentRoomId = null;
            window.location.hash = '';
            chatStream.innerHTML = '';
            appContainer.classList.add('hidden');
            roomModal.classList.remove('hidden');
            inputRoomId.value = '';
            showToast('Left room successfully');
        });
    }

    // --- Socket.IO & Real-time Room Handling ---
    function connectSocket() {
        if (typeof io === 'undefined') return;
        if (socket) socket.disconnect();

        socket = io();

        socket.on('connect', () => {
            if (currentRoomId) {
                socket.emit('room:join', { room_id: currentRoomId });
            }
        });

        socket.on('users:count', (count) => {
            if (userCountText) {
                userCountText.textContent = `${count} ${count === 1 ? 'user' : 'users'} online`;
            }
        });

        socket.on('message:new', (msg) => {
            appendMessageBubble(msg);
        });

        socket.on('message:deleted', (data) => {
            const el = document.getElementById(`msg-${data.id}`);
            if (el) {
                el.style.transition = 'all 0.25s ease';
                el.style.opacity = '0';
                el.style.transform = 'translateY(10px)';
                setTimeout(() => el.remove(), 250);
            }
        });

        socket.on('room:cleared', () => {
            chatStream.innerHTML = `
                <div id="empty-state" class="empty-state">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                    <p>No messages in this room yet</p>
                    <span>Type or paste text/files below. Anyone with this Room Code can join.</span>
                </div>`;
            showToast('Room chat cleared');
        });

        socket.on('message:typing', (data) => {
            if (data.session_id !== sessionId) {
                typingUserText.textContent = `${data.username || 'Someone'} is typing...`;
                typingIndicator.classList.remove('hidden');
                clearTimeout(remoteTypingTimeout);
                remoteTypingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 1500);
            }
        });
    }

    // --- Load Saved Chat History for Room ---
    async function loadChatHistory() {
        if (!currentRoomId) return;
        try {
            const res = await fetch(`/api/messages?room_id=${encodeURIComponent(currentRoomId)}`);
            if (!res.ok) return;
            const messages = await res.json();
            
            chatStream.innerHTML = '';
            if (Array.isArray(messages) && messages.length > 0) {
                messages.forEach(msg => appendMessageBubble(msg, false));
                scrollToBottom();
            } else {
                chatStream.innerHTML = `
                    <div id="empty-state" class="empty-state">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                        <p>No messages in this room yet</p>
                        <span>Type or paste text/files below. Anyone with this Room Code can join.</span>
                    </div>`;
            }
        } catch (err) {
            console.error('Error loading room history:', err);
            showToast('Failed to load room messages', true);
        }
    }

    // --- Render Message Bubbles ---
    function appendMessageBubble(msg, autoScroll = true) {
        if (!msg || !msg.id) return;
        if (document.getElementById(`msg-${msg.id}`)) return; // Prevent duplicates

        const emptyStateEl = chatStream.querySelector('.empty-state');
        if (emptyStateEl) {
            emptyStateEl.remove();
        }

        const isMine = msg.session_id === sessionId;
        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${isMine ? 'mine' : 'other'}`;
        wrapper.id = `msg-${msg.id}`;

        const senderName = isMine ? 'You' : (msg.username || 'User');
        const timeStr = formatTime(msg.created_at);

        let bubbleContentHtml = '';

        const isImage = msg.type === 'file' && /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(msg.original_name || msg.content || '');

        if (msg.type === 'file') {
            const downloadUrl = `/download/${msg.file_id || msg.id}`;
            const fileName = msg.original_name || msg.content || 'Attachment';
            const fileSize = formatBytes(msg.size);

            if (isImage) {
                bubbleContentHtml = `
                    <div class="chat-bubble image-bubble">
                        <div class="image-preview-card" data-url="${downloadUrl}" data-name="${fileName}">
                            <img src="${downloadUrl}" alt="${fileName}" class="chat-image-thumbnail">
                            <div class="image-card-overlay">
                                <span class="file-name">${fileName}</span>
                                <span class="file-size">${fileSize}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                bubbleContentHtml = `
                    <div class="chat-bubble file-bubble">
                        <div class="file-card">
                            <div class="file-icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                            </div>
                            <div class="file-details">
                                <span class="file-name" title="${fileName}">${fileName}</span>
                                <span class="file-size">${fileSize}</span>
                            </div>
                            <a href="${downloadUrl}" target="_blank" download class="btn-download-file">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                Save
                            </a>
                        </div>
                    </div>
                `;
            }
        } else {
            bubbleContentHtml = `
                <div class="chat-bubble text-bubble" title="Click anywhere to copy text">
                    <div class="message-text"></div>
                </div>
            `;
        }

        wrapper.dataset.msgId = msg.id;
        wrapper.dataset.content = msg.content || '';

        wrapper.innerHTML = `
            <div class="message-meta">
                <span class="message-sender">${senderName}</span>
                <span class="message-time">${timeStr}</span>
            </div>
            ${bubbleContentHtml}
        `;

        // RIGHT CLICK CONTEXT MENU ON MESSAGE BUBBLE
        wrapper.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            activeCtxTarget = wrapper;

            if (contextMenu) {
                contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
                contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 180)}px`;
                contextMenu.classList.remove('hidden');
            }
        });

        // Image Lightbox Trigger
        if (isImage) {
            const imgCard = wrapper.querySelector('.image-preview-card');
            if (imgCard) {
                imgCard.addEventListener('click', () => {
                    const url = imgCard.getAttribute('data-url');
                    const name = imgCard.getAttribute('data-name');
                    lightboxImg.src = url;
                    lightboxFilename.textContent = name;
                    lightboxDownload.href = url;
                    lightboxModal.classList.remove('hidden');
                });
            }
        }

        if (msg.type === 'text') {
            wrapper.querySelector('.message-text').textContent = msg.content || '';

            // CLICK MESSAGE BUBBLE TO COPY TEXT
            const bubbleEl = wrapper.querySelector('.chat-bubble');
            bubbleEl.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-delete-msg')) return;
                const textToCopy = msg.content || '';
                navigator.clipboard.writeText(textToCopy).then(() => {
                    let badge = bubbleEl.querySelector('.copied-badge');
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'copied-badge';
                        badge.textContent = 'Copied!';
                        bubbleEl.appendChild(badge);
                    }
                    setTimeout(() => {
                        if (badge) badge.remove();
                    }, 1500);
                }).catch(() => showToast('Failed to copy text', true));
            });
        }

        chatStream.appendChild(wrapper);
        if (autoScroll) scrollToBottom();
    }

    function scrollToBottom() {
        chatStream.scrollTop = chatStream.scrollHeight;
    }

    // --- Sending Messages ---
    async function sendTextMessage() {
        const content = chatInput.value.trim();
        if (!content || !currentRoomId) return;

        chatInput.value = '';
        chatInput.style.height = 'auto';

        const payload = {
            room_id: currentRoomId,
            session_id: sessionId,
            username: username,
            content: content
        };

        if (socket?.connected) {
            socket.emit('message:new', payload);
        } else {
            try {
                const res = await fetch('/api/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.message) appendMessageBubble(data.message);
                } else {
                    showToast('Failed to send message', true);
                }
            } catch (err) {
                showToast('Network error sending message', true);
            }
        }
    }

    btnSend.addEventListener('click', sendTextMessage);

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendTextMessage();
        }
    });

    // Auto-resize & typing indicator
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';

        isTyping = true;
        clearTimeout(typingTimeout);
        if (socket?.connected && currentRoomId) {
            socket.emit('message:typing', { room_id: currentRoomId, session_id: sessionId, username: username });
        }

        typingTimeout = setTimeout(() => {
            isTyping = false;
        }, 1200);
    });

    // --- File Upload ---
    btnAttach.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            uploadFile(e.target.files[0]);
            fileInput.value = '';
        }
    });

    async function uploadFile(file) {
        if (!file || !currentRoomId) return;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('room_id', currentRoomId);
        formData.append('session_id', sessionId);
        formData.append('username', username);

        showToast(`Uploading ${file.name}...`);

        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || 'Upload failed');
            }
            showToast('File shared successfully!');
        } catch (err) {
            showToast(err.message || 'File upload error', true);
        }
    }

    // --- Drag and Drop Overlay ---
    ['dragenter', 'dragover'].forEach(eventName => {
        window.addEventListener(eventName, (e) => {
            e.preventDefault(); e.stopPropagation();
            if (currentRoomId) dragOverlay.classList.remove('hidden');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        window.addEventListener(eventName, (e) => {
            e.preventDefault(); e.stopPropagation();
            if (e.type === 'dragleave' && e.clientX !== 0 && e.clientY !== 0) return;
            dragOverlay.classList.add('hidden');
        }, false);
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        dragOverlay.classList.add('hidden');
        if (currentRoomId && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            uploadFile(e.dataTransfer.files[0]);
        }
    });

    // --- Ctrl+V Image Paste Support ---
    document.addEventListener('paste', (e) => {
        if (!currentRoomId) return;
        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1 || items[i].kind === 'file') {
                const file = items[i].getAsFile();
                if (file) {
                    e.preventDefault();
                    uploadFile(file);
                    break;
                }
            }
        }
    });

    // Check URL Hash for Direct Room Join Code
    const hashRoom = window.location.hash.replace('#', '').trim().toLowerCase();
    if (hashRoom && hashRoom.length >= 4) {
        inputRoomId.value = hashRoom;
        if (typeof joinRoomForm.requestSubmit === 'function') {
            joinRoomForm.requestSubmit();
        } else {
            joinRoomForm.dispatchEvent(new Event('submit', { cancelable: true }));
        }
    }
});
