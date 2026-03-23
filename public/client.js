// ============================================================
//  THREE CATS HOCKEY — CLIENT  (optimized & bug-fixed)
// ============================================================

const socket = io();

// --- DOM refs ---
const authDiv        = document.getElementById('auth');
const menuDiv        = document.getElementById('menu');
const canvas         = document.getElementById('gameCanvas');
const ctx            = canvas.getContext('2d');
const authStatus     = document.getElementById('auth-status');
const chatContainer  = document.getElementById('chat-container');
const chatToggleBtn  = document.getElementById('chat-toggle-btn');
const mmOverlay      = document.getElementById('matchmaking-overlay');
const mmText         = document.getElementById('mm-text');
const eloDisplay     = document.getElementById('my-elo-display');
const afkScreen      = document.getElementById('afk-screen');
const chatInput      = document.getElementById('chat-input');
const chatMessages   = document.getElementById('chat-messages');

// --- Game constants ---
const PLAYER_RADIUS  = 40;
const PUCK_RADIUS    = 20;
const LERP_FACTOR    = 0.35;   // smoother interpolation (was 0.4)
const MAX_CHAT_MSGS  = 80;     // prevent unbounded DOM growth

// --- State ---
let myUsername      = '';
let myElo           = 1000;
let myCharacter     = 'korzhik';
let mySelectedMode  = 1;
let currentRoom     = null;
let myTeam          = null;
let isSpectator     = false;
let loopRunning     = false;   // BUG FIX: prevent multiple rAF loops
let eloChangeMsg    = '';
let isDragging      = false;
let showGoalAnimation  = false;
let goalScorerChar     = null;
let goalAnimationStart = 0;
let floatingTexts      = [];
let chatTimeout;

// --- Asset images ---
const images = {
    rink:           new Image(),
    puck:           new Image(),
    korzhik:        new Image(),
    karamelka:      new Image(),
    kompot:         new Image(),
    goal_korzhik:   new Image(),
    goal_karamelka: new Image(),
    goal_kompot:    new Image(),
};

images.rink.src           = 'assets/rink.jpg';
images.puck.src           = 'assets/puck.png';
images.korzhik.src        = 'assets/korzhik.png';
images.karamelka.src      = 'assets/karamelka.png';
images.kompot.src         = 'assets/kompot.png';
images.goal_korzhik.src   = 'assets/kor_gol.png';
images.goal_karamelka.src = 'assets/car_gol.png';
images.goal_kompot.src    = 'assets/kom_gol.png';

const charColors = {
    korzhik:   '0, 100, 255',
    karamelka: '255, 105, 180',
    kompot:    '0, 200, 0',
};

// Pre-create Audio objects; reuse them (avoid GC churn)
const hitSounds = [new Audio('assets/shay1.mp3'), new Audio('assets/shay2.mp3')];

// --- Game state ---
let gameState = {
    players: {},
    puck:    { x: 600, y: 300, rotation: 0 },
    score:   { team1: 0, team2: 0 },
    timeLeft: 180,
};

// ============================================================
//  MOBILE: block page scroll but allow chat input
// ============================================================
document.addEventListener('touchmove', (e) => {
    if (e.target !== chatInput) e.preventDefault();
}, { passive: false });

// ============================================================
//  FULLSCREEN
// ============================================================
function enableFullscreen() {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen || (() => {})).call(el);
}

// ============================================================
//  ONLINE COUNTER / PING
// ============================================================
socket.on('onlineCount', (count) => {
    document.getElementById('online-counter').innerText = `Онлайн: ${count}`;
});
socket.on('pingTimer', (ts) => socket.emit('pongTimer', ts));

// ============================================================
//  AUTH
// ============================================================
function register() {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    if (user && pass) socket.emit('register', { username: user, password: pass });
}

function login() {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    if (user && pass) socket.emit('login', { username: user, password: pass });
}

// Allow pressing Enter in login form
document.getElementById('password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});

socket.on('authResult', (res) => {
    if (res.success) {
        myUsername = res.username;
        myElo      = res.elo;
        authDiv.style.display  = 'none';
        menuDiv.style.display  = 'block';
        document.getElementById('welcome-text').innerText = `Привет, ${myUsername}!`;
        if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    } else {
        authStatus.innerText   = res.msg;
        authStatus.style.color = 'red';
    }
});

// ============================================================
//  MENU: character & mode selection
// ============================================================
function selectCharacter(char) {
    myCharacter = char;
    document.querySelectorAll('.char-btn').forEach(b => b.classList.remove('active-btn'));
    document.getElementById(`btn-${char}`).classList.add('active-btn');
}

function selectMode(mode) {
    mySelectedMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active-btn'));
    document.getElementById(`btn-mode-${mode}`).classList.add('active-btn');
}

// ============================================================
//  MATCHMAKING
// ============================================================
function startMatchmaking() {
    enableFullscreen();
    mmOverlay.style.display = 'flex';
    mmText.innerText = `Ищем игру ${mySelectedMode} на ${mySelectedMode}...`;
    socket.emit('findMatch', { character: myCharacter, username: myUsername, mode: mySelectedMode });
}

function cancelMatchmaking() {
    socket.emit('cancelMatchMatchmaking');
    mmOverlay.style.display = 'none';
}

function spectateRandomGame() {
    enableFullscreen();
    socket.emit('spectateRandom');
}

socket.on('waiting', (msg) => { mmText.innerText = msg; });

// BUG FIX: guard against missing player data before accessing .team
socket.on('matchFound', (data) => {
    isSpectator = false;
    currentRoom = data.roomId;
    gameState   = data.state;
    const me    = gameState.players[socket.id];
    myTeam      = me ? me.team : null;

    mmOverlay.style.display    = 'none';
    menuDiv.style.display      = 'none';
    canvas.style.display       = 'block';
    chatContainer.style.display = 'flex';
    if (chatToggleBtn) chatToggleBtn.style.display = 'flex';
    wakeUpChat();
    startGameLoop();
});

socket.on('spectateStart', (data) => {
    isSpectator = true;
    currentRoom = data.roomId;
    gameState   = data.state;
    myTeam      = null;

    mmOverlay.style.display    = 'none';
    menuDiv.style.display      = 'none';
    canvas.style.display       = 'block';
    chatContainer.style.display = 'flex';
    if (chatToggleBtn) chatToggleBtn.style.display = 'flex';
    wakeUpChat();
    startGameLoop();
    // BUG FIX: replaced alert() (blocks rAF) with a nicer non-blocking toast
    showToast('Вы подключились как зритель! 👁️');
});

socket.on('spectateError', (msg) => showToast(msg, true));

socket.on('afkWarning', () => {
    isSpectator = true;
    if (afkScreen) afkScreen.style.display = 'flex';
});

// ============================================================
//  GAME STATE UPDATES
// ============================================================
socket.on('gs', (mini) => {
    if (!currentRoom) return;

    // Puck
    gameState.puck.targetX = mini.u.x;
    gameState.puck.targetY = mini.u.y;
    gameState.puck.targetR = mini.u.r;

    // Score & time
    gameState.score    = mini.s;
    gameState.timeLeft = mini.t;

    // Players
    for (const id in mini.p) {
        if (!gameState.players[id]) {
            gameState.players[id] = { x: mini.p[id].x, y: mini.p[id].y, rotation: 0 };
        }
        const p = gameState.players[id];
        p.targetX = mini.p[id].x;
        p.targetY = mini.p[id].y;
        p.targetR = mini.p[id].r;
        p.ping    = mini.p[id].ping;
        p.isBot   = mini.p[id].isBot;
        // BUG FIX: sync char from server so late-join players render correctly
        if (mini.p[id].char) p.char = mini.p[id].char;
    }

    // Hit sound
    if (mini.h === 1) {
        const snd = hitSounds[Math.random() < 0.5 ? 0 : 1];
        snd.currentTime = 0;
        snd.play().catch(() => {});
    }
});

// ============================================================
//  ELO & GAME OVER
// ============================================================
socket.on('eloUpdated', (data) => {
    myElo = data.elo;
    if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;

    if (data.change > 0 && gameState.players[socket.id] && canvas.style.display === 'block') {
        const p = gameState.players[socket.id];
        floatingTexts.push({ x: p.x, y: p.y - 60, text: `+${data.change} ЭЛО!`, life: 90 });
    }
    // Store for game-over screen (skip bot-match fixed values)
    if (data.change !== 25 && data.change !== 10) {
        eloChangeMsg = `\nЭло за матч: ${data.change > 0 ? '+' : ''}${data.change} (Всего: ${myElo})`;
    }
});

socket.on('gameOver', (finalScore) => {
    let msg = 'Матч окончен!';
    if (!isSpectator && afkScreen.style.display !== 'flex') {
        const win  = (myTeam === 1 && finalScore.team1 > finalScore.team2) ||
                     (myTeam === 2 && finalScore.team2 > finalScore.team1);
        const lose = (myTeam === 1 && finalScore.team1 < finalScore.team2) ||
                     (myTeam === 2 && finalScore.team2 < finalScore.team1);
        msg = win ? 'ВЫ ПОБЕДИЛИ! 🎉' : lose ? 'ВЫ ПРОИГРАЛИ! 😭' : 'Ничья!';
    }
    // BUG FIX: stop the game loop before showing result
    currentRoom = null;
    setTimeout(() => {
        alert(`${msg}\nИтоговый счет: ${finalScore.team1} : ${finalScore.team2}${eloChangeMsg}`);
        location.reload();
    }, 500);
});

socket.on('goal', (char) => {
    goalScorerChar     = char;
    showGoalAnimation  = true;
    goalAnimationStart = performance.now();
});

// ============================================================
//  CHAT
// ============================================================
function toggleChat() {
    const hidden = chatContainer.style.display === 'none';
    chatContainer.style.display = hidden ? 'flex' : 'none';
    chatToggleBtn.innerText     = hidden ? '👁️' : '🙈';
    chatToggleBtn.classList.toggle('chat-hidden', !hidden);
    if (hidden) wakeUpChat();
}

function wakeUpChat() {
    if (chatContainer.style.display === 'none') return;
    chatContainer.style.opacity = '1';
    clearTimeout(chatTimeout);
    chatTimeout = setTimeout(() => {
        if (document.activeElement !== chatInput) chatContainer.style.opacity = '0.3';
    }, 4000);
}

chatInput.addEventListener('focus', () => {
    chatContainer.style.opacity = '1';
    clearTimeout(chatTimeout);
});
chatInput.addEventListener('blur', wakeUpChat);

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !currentRoom) return;
    const senderName = isSpectator ? `[Зритель] ${myUsername}` : myUsername;
    socket.emit('chatMessage', { roomId: currentRoom, sender: senderName, text });
    chatInput.value = '';
}

chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

socket.on('chatMessage', (data) => {
    if (chatContainer.style.display !== 'none') wakeUpChat();

    // BUG FIX: sanitize chat text to prevent XSS
    const div = document.createElement('div');
    const b   = document.createElement('b');
    b.textContent = data.sender + ':';
    div.appendChild(b);
    div.appendChild(document.createTextNode(' ' + data.text));
    chatMessages.appendChild(div);

    // BUG FIX: trim old messages to prevent unbounded memory use
    while (chatMessages.children.length > MAX_CHAT_MSGS) {
        chatMessages.removeChild(chatMessages.firstChild);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ============================================================
//  INPUT HANDLING
// ============================================================
function getEventPos(e) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const src    = (e.touches && e.touches.length > 0) ? e.touches[0] : e;
    return {
        x: (src.clientX - rect.left) * scaleX,
        y: (src.clientY - rect.top)  * scaleY,
    };
}

function sendInput(pos, dragging) {
    if (isSpectator || !currentRoom) return;
    socket.emit('input', {
        roomId:   currentRoom,
        dragging: dragging,
        tx:       pos ? pos.x : null,
        ty:       pos ? pos.y : null,
    });
}

function handleStart(e) {
    if (isSpectator) return;
    if (e.target.closest('#chat-container') || e.target.closest('#chat-toggle-btn')) return;

    const myPlayer = gameState.players[socket.id];
    if (!myPlayer) return;  // BUG FIX: guard against missing player

    const pos = getEventPos(e);
    const dx  = pos.x - myPlayer.x;
    const dy  = pos.y - myPlayer.y;
    if (Math.sqrt(dx * dx + dy * dy) <= PLAYER_RADIUS * 1.5) {
        isDragging = true;
        sendInput(pos, true);
    }
}

function handleEnd() {
    if (isDragging) {
        isDragging = false;
        sendInput(null, false);
    }
}

function handleMove(e) {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();
    sendInput(getEventPos(e), true);
}

canvas.addEventListener('mousedown',  handleStart);
window.addEventListener('mouseup',    handleEnd);
canvas.addEventListener('mousemove',  handleMove);
canvas.addEventListener('touchstart', handleStart, { passive: false });
window.addEventListener('touchend',   handleEnd);
canvas.addEventListener('touchmove',  handleMove,  { passive: false });

// ============================================================
//  RENDERING HELPERS
// ============================================================

/** Draw a circular-clipped image. Falls back to grey circle if not loaded. */
function safeDrawCircleImage(image, x, y, radius, rotation = 0) {
    if (!image.complete || image.naturalWidth === 0) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'gray';
        ctx.fill();
        return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, -radius, -radius, radius * 2, radius * 2);
    ctx.restore();
}

/** Draw player name + ping label above the player circle. */
function drawPlayerLabel(p, id) {
    const isMe     = (id === socket.id && !isSpectator);
    const pingVal  = p.ping || 0;
    const name     = p.isBot ? `🤖 ${p.username}` : p.username;
    const pingCol  = pingVal > 150 ? '#ff4d4d' : pingVal > 80 ? '#ffd633' : '#00ff00';

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.textAlign = 'center';

    // Name
    ctx.font      = isMe ? 'bold 14px Arial' : '14px Arial';
    ctx.fillStyle = isMe ? '#ffd700' : 'white';
    // Text shadow for readability
    ctx.shadowColor   = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur    = 4;
    ctx.fillText(name, 0, -PLAYER_RADIUS - 15);

    // Ping
    ctx.font      = 'bold 12px Arial';
    ctx.fillStyle = pingCol;
    ctx.fillText(`${pingVal} ms`, 0, -PLAYER_RADIUS - 2);

    ctx.shadowBlur = 0;
    ctx.restore();
}

/** Draw score + timer HUD */
function drawHUD() {
    // Score
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font      = 'bold 36px Arial';
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur  = 6;
    ctx.fillText(`${gameState.score.team1} : ${gameState.score.team2}`, canvas.width / 2, 50);

    // Timer
    const min = Math.floor(gameState.timeLeft / 60);
    const sec = gameState.timeLeft % 60;
    ctx.font      = 'bold 24px Arial';
    ctx.fillStyle = gameState.timeLeft <= 10 ? 'red' : 'yellow';
    ctx.fillText(`⏱ ${min}:${sec < 10 ? '0' : ''}${sec}`, canvas.width / 2, 85);
    ctx.shadowBlur = 0;
    ctx.restore();
}

/** Draw goal celebration animation */
function drawGoalAnimation(timestamp) {
    const elapsed  = timestamp - goalAnimationStart;
    let   opacity  = Math.min(elapsed / 500, 0.6);
    if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500);
    if (elapsed > 2500) { showGoalAnimation = false; return; }

    const flashColor = charColors[goalScorerChar] || '255,255,255';
    ctx.fillStyle    = `rgba(${flashColor}, ${opacity})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const goalImg = images[`goal_${goalScorerChar}`] || images.goal_korzhik;
    if (goalImg.complete && goalImg.naturalWidth > 0) {
        const scale    = opacity / 0.6;
        const size     = 300 + (1 - scale) * 40;  // slight zoom-in effect
        const halfSize = size / 2;
        ctx.globalAlpha = scale;
        ctx.drawImage(goalImg,
            canvas.width  / 2 - halfSize,
            canvas.height / 2 - halfSize,
            size, size);
        ctx.globalAlpha = 1;
    }
}

/** Draw floating +ELO texts */
function drawFloatingTexts() {
    ctx.textAlign = 'center';
    ctx.font      = 'bold 22px Arial';
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft      = floatingTexts[i];
        const alpha   = ft.life / 90;
        ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
        ctx.shadowColor   = 'black';
        ctx.shadowBlur    = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.fillText(ft.text, ft.x, ft.y);
        ft.y   -= 1;
        ft.life--;
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

// ============================================================
//  GAME LOOP
// ============================================================

/** BUG FIX: centralised start prevents duplicate rAF loops */
function startGameLoop() {
    if (loopRunning) return;
    loopRunning = true;
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    // Stop when room is gone (e.g. after gameOver)
    if (!currentRoom) { loopRunning = false; return; }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background rink
    if (images.rink.complete && images.rink.naturalWidth > 0) {
        ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);
    }

    // Interpolate & draw puck
    const pk = gameState.puck;
    if (pk.targetX !== undefined) {
        pk.x        += (pk.targetX - pk.x)               * LERP_FACTOR;
        pk.y        += (pk.targetY - pk.y)               * LERP_FACTOR;
        pk.rotation += (pk.targetR - (pk.rotation || 0)) * LERP_FACTOR;
    }
    safeDrawCircleImage(images.puck, pk.x, pk.y, PUCK_RADIUS, pk.rotation);

    // Players
    for (const id in gameState.players) {
        const p = gameState.players[id];
        if (p.targetX !== undefined) {
            p.x        += (p.targetX - p.x)               * LERP_FACTOR;
            p.y        += (p.targetY - p.y)               * LERP_FACTOR;
            p.rotation += (p.targetR - (p.rotation || 0)) * LERP_FACTOR;
        }
        const img = images[p.char] || images.korzhik;
        safeDrawCircleImage(img, p.x, p.y, PLAYER_RADIUS, p.rotation);
        drawPlayerLabel(p, id);
    }

    drawHUD();
    if (showGoalAnimation) drawGoalAnimation(timestamp);
    drawFloatingTexts();

    requestAnimationFrame(gameLoop);
}

// ============================================================
//  TOAST NOTIFICATION  (replaces blocking alert() for non-critical msgs)
// ============================================================
function showToast(msg, isError = false) {
    let toast = document.getElementById('_toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = '_toast';
        Object.assign(toast.style, {
            position:   'fixed',
            top:        '20px',
            left:       '50%',
            transform:  'translateX(-50%)',
            background: 'rgba(20,20,20,0.92)',
            color:      'white',
            padding:    '12px 28px',
            borderRadius: '30px',
            fontSize:   '16px',
            fontWeight: 'bold',
            zIndex:     '9999',
            pointerEvents: 'none',
            transition: 'opacity 0.4s',
            maxWidth:   '80vw',
            textAlign:  'center',
        });
        document.body.appendChild(toast);
    }
    toast.style.borderTop = isError ? '3px solid #ff4d4d' : '3px solid #00ffcc';
    toast.innerText       = msg;
    toast.style.opacity   = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
