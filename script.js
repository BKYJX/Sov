
(function() {
    'use strict';

    /* ================================================================
     * 后端接口预留（TODO 对接）
     * ----------------------------------------------------------------
     * 当前为纯前端版本：消息只在本页内存中渲染，发送后刷新即丢失。
     * 后端就绪后只需：
     *   1. 填写 CONFIG.api.baseUrl（例如 'http://10.66.1.98:8000'）；
     *   2. 在 loadMessages() 中用 GET  替换占位逻辑；
     *   3. 在 sendMessage()   中用 POST 替换占位逻辑（失败调用 rollbackMessage）。
     * 接口约定（可协商调整）：
     *   GET  {baseUrl}/api/messages
     *        -> 期望返回 [{ id, username, role, avatar, content, timestamp }]
     *   POST {baseUrl}/api/messages/send
     *        -> 请求体 { username, role, avatar, content }
     *        -> 期望返回 { ok: true, message: { id, username, role, avatar, content, timestamp } }
     * ================================================================
     * 接收他人消息（后端推送）：
     *   - 统一入口：window.ChatAPI.receiveMessage(msgObj)
     *   - WebSocket 接入：ws.onmessage = e => ChatAPI.receiveMessage(JSON.parse(e.data).message)
     *   - 轮询增量接入：把新增消息逐个交给 receiveMessage()
     *   - receiveMessage 自动处理：按 id 去重、自动分组、滚动到底、自动加入成员列表
     * ================================================================ */
    const CONFIG = {
        channel: {
            name: 'general',
            tag: '动态测试',
        },
        currentUser: {
            username: 'You',
            role: '',
            avatar: 'Y',
        },
        api: {
            baseUrl: '',
            endpoints: {
                list: '/api/messages',
                send: '/api/messages/send',
            }
        }
    };

    /* ===== 元素引用 ===== */
    const messageArea  = document.getElementById('messageArea');
    const emptyState   = document.getElementById('emptyState');
    const msgInput     = document.getElementById('msgInput');   // textarea
    const sendBtn      = document.getElementById('sendBtn');
    const memberList   = document.getElementById('memberList');
    const memberCount  = document.getElementById('memberCount');
    const channelItems = document.querySelectorAll('.sidebar-item[data-channel]');

    /* ===== 数据 ===== */
    let messages = [];
    const receivedIds = new Set();
    const members = new Map(); // username -> { avatar, role, status }

    /* ===== 工具函数 ===== */

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    // 渲染消息文本：先转义，再把 @用户名 高亮为 mention
    function renderContent(text) {
        const escaped = escapeHtml(text);
        return escaped.replace(/@([\w\u4e00-\u9fa5_-]+)/g, '<span class="mention">@$1</span>');
    }

    function formatTime(date) {
        const h = date.getHours();
        const m = date.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        const mm = String(m).padStart(2, '0');
        return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear() +
               ' ' + h12 + ':' + mm + ' ' + ampm;
    }

    function formatDate(date) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((today - msgDay) / 86400000);
        if (diffDays === 0) return '今天';
        if (diffDays === 1) return '昨天';
        return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + date.getFullYear();
    }

    function isSameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    /* ===== 渲染 ===== */

    function isContinued(prev, cur) {
        return !!(prev && prev.username === cur.username);
    }

    function messageTemplate(m, opts) {
        const continued = opts && opts.continued;
        const roleHtml = (!continued && m.role)
            ? '<span class="role-badge">' + escapeHtml(m.role) + '</span>'
            : '';
        const headerHtml = continued ? '' :
            '<div class="msg-header">' +
                '<span class="msg-username">' + escapeHtml(m.username) + roleHtml + '</span>' +
                '<span class="msg-timestamp">' + escapeHtml(m.timestampText || '') + '</span>' +
            '</div>';
        return '' +
            '<div class="message-item">' +
                '<div class="msg-avatar" style="background: var(--msg-avatar-bg);">' + escapeHtml(m.avatar || '?') + '</div>' +
                '<div class="msg-content">' +
                    headerHtml +
                    '<div class="msg-text">' + renderContent(m.content) + '</div>' +
                    '<div class="msg-actions">' +
                        '<span class="action-reply" title="回复"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>' +
                        '<span class="action-edit" title="编辑"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    function dateSeparatorTemplate(date) {
        return '<div class="highlight-date">' +
            '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
            formatDate(date) +
            '</div>';
    }

    // 根据 messages 数据统一更新每条消息的分组 class
    function applyGroupClasses() {
        const items = messageArea.querySelectorAll('.message-item');
        items.forEach(function(el, i) {
            const m = messages[i];
            const prev = messages[i - 1];
            const next = messages[i + 1];
            el.classList.toggle('msg-continued', !!(prev && prev.username === m.username));
            el.classList.toggle('msg-group-end', !!(next && next.username !== m.username));
        });
    }

    // 全量渲染（带日期分隔条）
    function renderMessages() {
        messageArea.innerHTML = '';
        if (messages.length === 0) {
            messageArea.appendChild(emptyState);
            return;
        }
        const frag = document.createDocumentFragment();
        let lastDate = null;
        messages.forEach(function(m, i) {
            if (!lastDate || !isSameDay(lastDate, m.timestamp)) {
                frag.insertAdjacentHTML('beforeend', dateSeparatorTemplate(m.timestamp));
                lastDate = m.timestamp;
            }
            frag.insertAdjacentHTML('beforeend', messageTemplate(m, { continued: isContinued(messages[i - 1], m) }));
        });
        messageArea.appendChild(frag);
        applyGroupClasses();
        scrollToBottom();
    }

    // 追加单条（自动判断日期分隔与分组）
    function appendMessage(m) {
        if (emptyState.parentNode === messageArea) {
            emptyState.parentNode.removeChild(emptyState);
        }
        const prev = messages[messages.length - 1];
        if (!prev || !isSameDay(prev.timestamp, m.timestamp)) {
            messageArea.insertAdjacentHTML('beforeend', dateSeparatorTemplate(m.timestamp));
        }
        messages.push(m);
        messageArea.insertAdjacentHTML('beforeend', messageTemplate(m, { continued: isContinued(prev, m) }));
        applyGroupClasses();
        scrollToBottom();
    }

    function scrollToBottom() {
        messageArea.scrollTop = messageArea.scrollHeight;
    }

    function makeMessage(partial) {
        const now = new Date();
        let ts = now;
        if (partial.timestamp) {
            const parsed = new Date(partial.timestamp);
            if (!isNaN(parsed.getTime())) ts = parsed;
        }
        return {
            id: partial.id != null ? partial.id : Date.now(),
            username: partial.username || '?',
            role: partial.role || '',
            avatar: partial.avatar || '?',
            content: partial.content || '',
            timestamp: ts,
            timestampText: partial.timestampText || formatTime(ts),
        };
    }

    /* ===== 成员管理 ===== */

    function ensureMember(msg) {
        if (members.has(msg.username)) return;
        members.set(msg.username, { avatar: msg.avatar, role: msg.role, status: 'online' });
        const item = document.createElement('div');
        item.className = 'member-item';
        item.dataset.username = msg.username;
        item.innerHTML =
            '<span class="avatar">' + escapeHtml(msg.avatar || '?') + '</span>' +
            '<span class="member-name">' + escapeHtml(msg.username) + '</span>' +
            (msg.role ? '<span class="role-tag">' + escapeHtml(msg.role) + '</span>' : '') +
            '<span class="status-dot status-online"></span>';
        memberList.appendChild(item);
        updateOnlineCount();
    }

    function updateOnlineCount() {
        const count = memberList.children.length;
        memberCount.textContent = count;
        document.getElementById('onlineCount').textContent = count;
        document.getElementById('channelTag').textContent = count + ' Online';
    }

    /* ===== 发送消息 ===== */

    // textarea 自适应高度
    function autoResize() {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    }

    // 发送失败回滚（后端对接时调用）
    function rollbackMessage(id) {
        const idx = messages.findIndex(function(m) { return m.id === id; });
        if (idx !== -1) {
            messages.splice(idx, 1);
            renderMessages();
        }
    }

    function sendMessage() {
        const text = msgInput.value.trim();
        // 无论是否为空都清空输入框（修复空内容发送后残留空格）
        msgInput.value = '';
        autoResize();
        if (!text) return;

        const msg = makeMessage({
            username: CONFIG.currentUser.username,
            role: CONFIG.currentUser.role,
            avatar: CONFIG.currentUser.avatar,
            content: text,
        });

        receivedIds.add(msg.id);
        appendMessage(msg);
        msgInput.focus();

        // TODO 后端对接：发送请求，失败则回滚
        // fetch(CONFIG.api.baseUrl + CONFIG.api.endpoints.send, {
        //     method: 'POST',
        //     headers: { 'Content-Type': 'application/json' },
        //     body: JSON.stringify({ username: CONFIG.currentUser.username, role: CONFIG.currentUser.role, avatar: CONFIG.currentUser.avatar, content: text }),
        // })
        // .then(r => r.json())
        // .then(res => { if (!res.ok) rollbackMessage(msg.id); })
        // .catch(err => { rollbackMessage(msg.id); console.error('发送失败', err); });
    }

    /* ===== 接收他人消息（后端对接入口） ===== */
    function receiveMessage(raw) {
        if (!raw || raw.content == null) return null;
        const msg = makeMessage(raw);
        if (receivedIds.has(msg.id)) return null;
        receivedIds.add(msg.id);
        ensureMember(msg);
        appendMessage(msg);
        return msg;
    }

    window.ChatAPI = {
        receiveMessage: receiveMessage,
    };

    /* ===== 拉取历史消息（后端预留） ===== */
    function loadMessages() {
        // TODO 后端对接：将下面占位逻辑替换为真实请求
        // fetch(CONFIG.api.baseUrl + CONFIG.api.endpoints.list)
        //     .then(r => r.json())
        //     .then(list => { (list || []).forEach(receiveMessage); })
        //     .catch(err => console.error('拉取历史消息失败', err));

        renderMessages();
    }

    /* ===== 频道切换 ===== */
    function switchChannel(name) {
        channelItems.forEach(function(item) { item.classList.remove('active'); });
        var target = document.querySelector('.sidebar-item[data-channel="' + CSS.escape(name) + '"]');
        if (target) target.classList.add('active');
        CONFIG.channel.name = name;
        document.getElementById('channelName').textContent = name;
        // 清空当前频道消息
        messages = [];
        receivedIds.clear();
        renderMessages();
        // TODO 后端对接：加载该频道的历史消息
    }

    /* ===== 主题切换 ===== */
    const themeAuto  = document.getElementById('themeAuto');
    const themeLight = document.getElementById('themeLight');
    const themeDark  = document.getElementById('themeDark');
    const allBtns = [themeAuto, themeLight, themeDark];

    function setActiveBtn(activeBtn) {
        allBtns.forEach(btn => btn.classList.remove('active'));
        if (activeBtn) activeBtn.classList.add('active');
    }

    function setTheme(mode) {
        const root = document.documentElement;
        root.removeAttribute('data-theme');
        if (mode === 'light') {
            root.setAttribute('data-theme', 'light');
            setActiveBtn(themeLight);
        } else if (mode === 'dark') {
            root.setAttribute('data-theme', 'dark');
            setActiveBtn(themeDark);
        } else {
            root.removeAttribute('data-theme');
            setActiveBtn(themeAuto);
        }
        try {
            localStorage.setItem('mr-chat-theme', mode);
        } catch(e) {}
    }

    function loadTheme() {
        let saved = 'auto';
        try {
            const stored = localStorage.getItem('mr-chat-theme');
            if (stored === 'light' || stored === 'dark' || stored === 'auto') {
                saved = stored;
            }
        } catch(e) {}
        setTheme(saved);
    }

    /* ===== 初始化 ===== */
    function init() {
        // 频道信息
        document.getElementById('channelName').textContent = CONFIG.channel.name;
        document.getElementById('channelTag').textContent = CONFIG.channel.tag;

        // 当前用户信息
        document.getElementById('selfMemberAvatar').textContent = CONFIG.currentUser.avatar;
        document.getElementById('selfMemberName').textContent = CONFIG.currentUser.username;

        // 成员列表初始化（自己）
        members.set(CONFIG.currentUser.username, {
            avatar: CONFIG.currentUser.avatar,
            role: CONFIG.currentUser.role,
            status: 'online'
        });
        updateOnlineCount();

        // 发送按钮
        sendBtn.addEventListener('click', sendMessage);

        // textarea：Enter 发送，Shift+Enter 换行
        msgInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // textarea 自适应高度
        msgInput.addEventListener('input', autoResize);

        // 消息操作图标事件委托（hover 显示由 CSS 控制）
        messageArea.addEventListener('click', function(e) {
            var reply = e.target.closest('.action-reply');
            if (reply) { msgInput.focus(); return; }
            var edit = e.target.closest('.action-edit');
            if (edit) { msgInput.focus(); }
        });

        // 频道切换
        channelItems.forEach(function(item) {
            item.addEventListener('click', function() {
                switchChannel(this.dataset.channel);
            });
        });

        // 主题
        themeAuto.addEventListener('click', function() { setTheme('auto'); });
        themeLight.addEventListener('click', function() { setTheme('light'); });
        themeDark.addEventListener('click', function() { setTheme('dark'); });
        loadTheme();

        // 拉取历史消息
        loadMessages();

        msgInput.focus();
        autoResize();
    }

    init();
})();
