(function() {
    'use strict';

    /* ================================================================
     * Sov 前端 — 已接入 sov-serverside 后端（Docker :8443）
     * ----------------------------------------------------------------
     * 后端：GitHub BKYJX/sov-serverside（Go，单进程单群组，文件存储）
     * 认证：请求头 X-User-Id + X-Password（明文比对 bcrypt，生产应置于 HTTPS 后）
     * 消息：POST /chat/send  +  GET /chat/messages?date=YYYY-MM-DD&since=<unix秒>
     * 消息行格式：timestamp|senderId|ciphertext|encryptedKeysJson
     *   - ciphertext 为 Opaque 字符串，服务器不解码；
     *   - 当前客户端约定 ciphertext = base64(JSON({v:1, content:文本}))，
     *     属于传输占位。真正 E2EE（公钥加密 + encryptedKeys 密钥分发）待后续实现。
     * 轮询：每 3 秒增量拉取 since=最后一条时间戳，行级 id 去重。
     * ================================================================ */
    const CONFIG = {
        channel: {
            name: 'general',
            tag: '动态测试',
        },
        // 当前登录用户（开发阶段硬编码，生产应由登录表单提供）
        user: {
            id: 'You',            // 后端 userId（与 X-User-Id 一致）
            password: 'sovtest123', // 后端密码（≥6 位，管理员在启动时设置）
            displayName: 'You',
            avatar: 'Y',
        },
        api: {
            // 自动跟随页面来源 host：页面在 10.66.1.98:80，后端同机 8443
            get baseUrl() { return location.protocol + '//' + location.hostname + ':8443'; },
            endpoints: {
                health: '/health',
                list: '/chat/messages',
                send: '/chat/send',
                members: '/members/list',
            }
        },
        pollInterval: 3000, // 轮询间隔（ms）
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
    const receivedIds = new Set();  // 已显示消息的行 id（去重）
    const pendingSent = [];         // 本地已乐观渲染、待后端确认的消息 { localId, senderId, ciphertext }
    const members = new Map();      // username -> { avatar, role, status }
    let lastPollTs = 0;             // 轮询增量起点（Unix 秒）

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

    function formatDateKey(date) {
        return date.getFullYear() + '-' +
               String(date.getMonth() + 1).padStart(2, '0') + '-' +
               String(date.getDate()).padStart(2, '0');
    }

    /* ===== 后端通信 ===== */

    // 带认证头的 fetch 封装；返回 JSON；失败抛错
    async function apiFetch(path, options) {
        const opts = options || {};
        const headers = Object.assign({
            'Content-Type': 'application/json',
            'X-User-Id': CONFIG.user.id,
            'X-Password': CONFIG.user.password,
        }, opts.headers || {});
        const res = await fetch(CONFIG.api.baseUrl + path, Object.assign({}, opts, { headers: headers }));
        let data = {};
        try { data = await res.json(); } catch (e) {}
        if (!res.ok || data.success === false) {
            throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
    }

    // 明文打包为 ciphertext（传输占位；真 E2EE 待实现）
    function encodePayload(text) {
        const json = JSON.stringify({ v: 1, content: text });
        return btoa(unescape(encodeURIComponent(json)));
    }

    function decodePayload(ciphertext) {
        try {
            const json = decodeURIComponent(escape(atob(ciphertext)));
            const obj = JSON.parse(json);
            return (obj && obj.v === 1) ? (obj.content || '') : null;
        } catch (e) {
            return null;
        }
    }

    // 解析后端消息行：timestamp|senderId|ciphertext|encryptedKeysJson
    function parseMessageLine(line) {
        const idx1 = line.indexOf('|');
        if (idx1 <= 0) return null;
        const ts = parseInt(line.slice(0, idx1), 10);
        if (isNaN(ts)) return null;
        const rest = line.slice(idx1 + 1);
        const idx2 = rest.indexOf('|');
        if (idx2 <= 0) return null;
        const rest2 = rest.slice(idx2 + 1);
        // ciphertext 为第三个 | 之前的部分（尾部的 encryptedKeysJson 当前前端不使用，忽略）
        const idx3 = rest2.indexOf('|');
        const ciphertext = idx3 === -1 ? rest2 : rest2.slice(0, idx3);
        return {
            ts: ts,
            senderId: rest.slice(0, idx2),
            ciphertext: ciphertext,
        };
    }

    // 行消息的唯一 id（同秒同人同内容视为同一条）
    function lineId(parsed) {
        return parsed.ts + '-' + parsed.senderId + '-' + parsed.ciphertext.slice(0, 32);
    }

    // 处理一条后端消息行：去重 → 跳过本地已发送 → 接收渲染
    function ingestLine(line) {
        const parsed = parseMessageLine(line);
        if (!parsed) return;
        const id = lineId(parsed);
        if (receivedIds.has(id)) return;

        // 本地刚发送成功的消息（乐观渲染过）：跳过并移除缓存
        const dupIdx = pendingSent.findIndex(function(p) {
            return p.senderId === parsed.senderId && p.ciphertext === parsed.ciphertext;
        });
        if (dupIdx !== -1) {
            pendingSent.splice(dupIdx, 1);
            receivedIds.add(id);
            if (parsed.ts > lastPollTs) lastPollTs = parsed.ts;
            return;
        }

        const content = decodePayload(parsed.ciphertext);
        if (content == null) return; // 无法解析的密文跳过（如其他客户端 E2EE 消息）

        const msg = receiveMessage({
            id: id,
            username: parsed.senderId,
            avatar: parsed.senderId.charAt(0).toUpperCase(),
            content: content,
            timestamp: new Date(parsed.ts * 1000),
        });
        if (msg && parsed.ts > lastPollTs) lastPollTs = parsed.ts;
    }

    // 拉取历史 + 增量轮询共用的请求
    async function fetchMessages(since) {
        const path = CONFIG.api.endpoints.list + '?date=' + formatDateKey(new Date()) +
                     (since > 0 ? '&since=' + since : '');
        const data = await apiFetch(path);
        (data.messages || []).forEach(ingestLine);
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
        let html = '';
        let lastDate = null;
        messages.forEach(function(m, i) {
            if (!lastDate || !isSameDay(lastDate, m.timestamp)) {
                html += dateSeparatorTemplate(m.timestamp);
                lastDate = m.timestamp;
            }
            html += messageTemplate(m, { continued: isContinued(messages[i - 1], m) });
        });
        messageArea.innerHTML = html;
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
        let ts;
        if (partial.timestamp instanceof Date) {
            ts = partial.timestamp;
        } else if (partial.timestamp != null) {
            const parsed = new Date(partial.timestamp);
            ts = isNaN(parsed.getTime()) ? new Date() : parsed;
        } else {
            ts = new Date();
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

    // 从后端拉取成员列表（members.txt）
    async function loadMembers() {
        try {
            const data = await apiFetch(CONFIG.api.endpoints.members);
            (data.members || []).forEach(function(m) {
                if (!m || !m.userId || m.userId === CONFIG.user.id) return; // 自己由 init 添加
                ensureMember({
                    username: m.userId,
                    avatar: m.userId.charAt(0).toUpperCase(),
                    role: '',
                });
            });
        } catch (e) {
            console.error('拉取成员列表失败', e);
        }
    }

    /* ===== 发送消息 ===== */

    // textarea 自适应高度
    function autoResize() {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    }

    // 发送失败回滚：从本地列表移除该条并重渲染
    function rollbackMessage(id) {
        const idx = messages.findIndex(function(m) { return m.id === id; });
        if (idx !== -1) {
            messages.splice(idx, 1);
            renderMessages();
        }
    }

    async function sendMessage() {
        const text = msgInput.value.trim();
        // 无论是否为空都清空输入框
        msgInput.value = '';
        autoResize();
        if (!text) return;

        const msg = makeMessage({
            username: CONFIG.user.displayName || CONFIG.user.id,
            role: '',
            avatar: CONFIG.user.avatar,
            content: text,
        });
        const ciphertext = encodePayload(text);

        // 乐观渲染
        receivedIds.add(msg.id);
        appendMessage(msg);
        msgInput.focus();

        // 发送到后端
        try {
            await apiFetch(CONFIG.api.endpoints.send, {
                method: 'POST',
                body: JSON.stringify({
                    senderId: CONFIG.user.id,
                    ciphertext: ciphertext,
                    encryptedKeys: {},
                }),
            });
            // 记录待确认消息：轮询拉回同一条时跳过（本地已显示）
            pendingSent.push({ localId: msg.id, senderId: CONFIG.user.id, ciphertext: ciphertext });
        } catch (e) {
            rollbackMessage(msg.id);
            console.error('发送失败', e);
        }
    }

    /* ===== 接收他人消息（后端轮询 / 外部推送共用入口） ===== */
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

    /* ===== 拉取历史消息（后端） ===== */
    async function loadMessages() {
        try {
            await fetchMessages(0); // 拉当天全部历史
            await loadMembers();
        } catch (e) {
            console.error('拉取历史消息失败', e);
        }
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
        if (name === 'general') {
            // general 频道对接后端群组
            loadMessages();
        }
        // TODO 后端暂为单群组设计；开发/语音频道为本地隔离频道，后续如需多频道可扩展
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
        document.getElementById('selfMemberAvatar').textContent = CONFIG.user.avatar;
        document.getElementById('selfMemberName').textContent = CONFIG.user.displayName;

        // 成员列表初始化（自己）
        members.set(CONFIG.user.id, {
            avatar: CONFIG.user.avatar,
            role: 'Admin',
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

        // 消息操作图标事件委托
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

        // 拉取历史消息 + 成员列表
        loadMessages();

        // 增量轮询（仅 general 频道）
        setInterval(function() {
            if (CONFIG.channel.name !== 'general') return;
            fetchMessages(lastPollTs).catch(function(e) {
                // 轮询失败静默（网络抖动/后端重启），下轮重试
            });
        }, CONFIG.pollInterval);

        msgInput.focus();
        autoResize();
    }

    init();
})();
