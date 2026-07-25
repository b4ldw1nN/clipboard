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
    const btnCopyRoom = document.getElementById('btn-copy-room');
    const btnLeaveRoom = document.getElementById('btn-leave-room');

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
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.2s, transform 0.2s';
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(30px)';
            setTimeout(() => toast.remove(), 200);
        }, 3000);
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

        socket.on('file:uploaded', (msg) => {
            appendMessageBubble(msg);
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

        if (msg.type === 'file') {
            const downloadUrl = `/download/${msg.file_id || msg.id}`;
            const fileName = msg.original_name || msg.content || 'Attachment';
            const fileSize = formatBytes(msg.size);

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
        } else {
            bubbleContentHtml = `
                <div class="chat-bubble text-bubble" title="Click anywhere to copy text">
                    <div class="message-text"></div>
                </div>
            `;
        }

        wrapper.innerHTML = `
            <div class="message-meta">
                <span class="message-sender">${senderName}</span>
                <span class="message-time">${timeStr}</span>
            </div>
            ${bubbleContentHtml}
        `;

        if (msg.type === 'text') {
            wrapper.querySelector('.message-text').textContent = msg.content || '';

            // CLICK MESSAGE BUBBLE TO COPY TEXT
            const bubbleEl = wrapper.querySelector('.chat-bubble');
            bubbleEl.addEventListener('click', () => {
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
