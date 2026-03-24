const socket = io();

const authDiv       = document.getElementById('auth');
const menuDiv       = document.getElementById('menu');
const canvas        = document.getElementById('gameCanvas');
const ctx           = canvas.getContext('2d');
const authStatus    = document.getElementById('auth-status');
const chatContainer = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const mmOverlay     = document.getElementById('matchmaking-overlay');
const mmText        = document.getElementById('mm-text');
const eloDisplay    = document.getElementById('my-elo-display');
const afkScreen     = document.getElementById('afk-screen');

let myUsername = '', myElo = 1000, myCharacter = 'korzhik', mySelectedMode = 1,
    currentRoom = null, myTeam = null, isSpectator = false;

const PLAYER_RADIUS = 40, PUCK_RADIUS = 20, WALL_PADDING = 25;

// === ЗОБРАЖЕННЯ ===
const images = {
    rink: new Image(), puck: new Image(),
    korzhik: new Image(), karamelka: new Image(), kompot: new Image(), gonya: new Image(),
    goal_korzhik: new Image(), goal_karamelka: new Image(), goal_kompot: new Image(), goal_gonya: new Image()
};
images.rink.src          = 'assets/rink.jpg';
images.puck.src          = 'assets/puck.png';
images.korzhik.src       = 'assets/korzhik.png';
images.karamelka.src     = 'assets/karamelka.png';
images.kompot.src        = 'assets/kompot.png';
images.gonya.src         = 'assets/gonya.png';
images.goal_korzhik.src  = 'assets/kor_gol.png';
images.goal_karamelka.src= 'assets/car_gol.png';
images.goal_kompot.src   = 'assets/kom_gol.png';
images.goal_gonya.src    = 'assets/gon_gol.png';

// === ЗВУКИ ===
const hitSounds  = [new Audio('assets/shay1.mp3'), new Audio('assets/shay2.mp3')];
const startSound = new Audio('assets/start.mp3');

const charColors = {
    korzhik:   '0, 100, 255',
    karamelka: '255, 105, 180',
    kompot:    '0, 200, 0',
    gonya:     '255, 165, 0',
};

let gameState = { players: {}, puck: { x: 600, y: 300, rotation: 0 }, score: { team1: 0, team2: 0 }, timeLeft: 180 };
let isDragging = false, showGoalAnimation = false, goalScorerChar = null, goalAnimationStart = 0, floatingTexts = [];

// === ЗАХИСТ ВІД СКРОЛУ (МОБІЛЬНІ) ===
document.addEventListener('touchmove', function(e) {
    if (e.target.tagName !== 'INPUT') e.preventDefault();
}, { passive: false });

// === ПОВНОЕКРАННИЙ РЕЖИМ ===
function enableFullscreen() {
    const elem = document.documentElement;
    if      (elem.requestFullscreen)       elem.requestFullscreen();
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    else if (elem.msRequestFullscreen)     elem.msRequestFullscreen();
}

// === ОНЛАЙН / PING ===
socket.on('onlineCount', (count) => { document.getElementById('online-counter').innerText = `Онлайн: ${count}`; });
socket.on('pingTimer',   (ts)    => { socket.emit('pongTimer', ts); });

// === АВТОРИЗАЦІЯ ===
function register() {
    const user = document.getElementById('username').value, pass = document.getElementById('password').value;
    if (user && pass) socket.emit('register', { username: user, password: pass });
}
function login() {
    const user = document.getElementById('username').value, pass = document.getElementById('password').value;
    if (user && pass) socket.emit('login', { username: user, password: pass });
}
socket.on('authResult', (res) => {
    if (res.success) {
        myUsername = res.username; myElo = res.elo;
        authDiv.style.display = 'none'; menuDiv.style.display = 'block';
        document.getElementById('welcome-text').innerText = `Привет, ${myUsername}!`;
        if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    } else {
        authStatus.innerText = res.msg; authStatus.style.color = 'red';
    }
});

// === ВИБІР ПЕРСОНАЖА / РЕЖИМУ ===
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

// === МАТЧМЕЙКІНГ ===
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

// === ПОЧАТОК ГРИ ===
function enterGame(roomId, state, spectator) {
    isSpectator = spectator;
    currentRoom = roomId;
    gameState   = state;
    if (!spectator) myTeam = gameState.players[socket.id]?.team;
    mmOverlay.style.display = 'none';
    menuDiv.style.display   = 'none';
    canvas.style.display    = 'block';
    chatContainer.style.display = 'flex';
    if (chatToggleBtn) chatToggleBtn.style.display = 'flex';
    wakeUpChat();

    // Звук старту раунду
    startSound.currentTime = 0;
    startSound.play().catch(() => {});

    requestAnimationFrame(gameLoop);
}

socket.on('waiting',      (msg)  => { mmText.innerText = msg; });
socket.on('matchFound',   (data) => { enterGame(data.roomId, data.state, false); });
socket.on('spectateStart',(data) => { enterGame(data.roomId, data.state, true); alert('Вы подключились как зритель! 👁️'); });
socket.on('spectateError',(msg)  => { alert(msg); });
socket.on('afkWarning',   ()     => { isSpectator = true; if (afkScreen) afkScreen.style.display = 'flex'; });

// === ОНОВЛЕННЯ СТАНУ ГРИ ===
socket.on('gs', (miniState) => {
    if (!currentRoom) return;
    gameState.puck.targetX = miniState.u.x;
    gameState.puck.targetY = miniState.u.y;
    gameState.puck.targetR = miniState.u.r;
    gameState.score    = miniState.s;
    gameState.timeLeft = miniState.t;

    for (const id in miniState.p) {
        if (!gameState.players[id]) gameState.players[id] = { x: miniState.p[id].x, y: miniState.p[id].y, rotation: 0 };
        gameState.players[id].targetX = miniState.p[id].x;
        gameState.players[id].targetY = miniState.p[id].y;
        gameState.players[id].targetR = miniState.p[id].r;
        gameState.players[id].ping    = miniState.p[id].ping;
        gameState.players[id].isBot   = miniState.p[id].isBot;
    }

    if (miniState.h === 1) {
        const snd = hitSounds[Math.floor(Math.random() * hitSounds.length)];
        snd.currentTime = 0; snd.play().catch(() => {});
    }
});

// === ГОЛ ===
socket.on('goal', (char) => {
    goalScorerChar     = char;
    showGoalAnimation  = true;
    goalAnimationStart = performance.now();

    // Звук старту після голу (коли шайба скидається)
    setTimeout(() => {
        startSound.currentTime = 0;
        startSound.play().catch(() => {});
    }, 2500);
});

// === ЕЛО ===
let eloChangeMsg = '';
socket.on('eloUpdated', (data) => {
    myElo = data.elo;
    if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    if (data.change > 0 && gameState.players[socket.id] && canvas.style.display === 'block') {
        const p = gameState.players[socket.id];
        floatingTexts.push({ x: p.x, y: p.y - 60, text: `+${data.change} ЭЛО!`, life: 90 });
    }
    if (data.change !== 25 && data.change !== 10)
        eloChangeMsg = `\nЭло за матч: ${data.change > 0 ? '+' : ''}${data.change} (Всего: ${myElo})`;
});

// === КІНЕЦЬ МАТЧУ ===
socket.on('gameOver', (finalScore) => {
    let msg = 'Матч окончен!';
    if (!isSpectator && afkScreen.style.display !== 'flex') {
        if      (myTeam === 1 && finalScore.team1 > finalScore.team2) msg = 'ВЫ ПОБЕДИЛИ! 🎉';
        else if (myTeam === 1 && finalScore.team1 < finalScore.team2) msg = 'ВЫ ПРОИГРАЛИ! 😭';
        else if (myTeam === 2 && finalScore.team2 > finalScore.team1) msg = 'ВЫ ПОБЕДИЛИ! 🎉';
        else if (myTeam === 2 && finalScore.team2 < finalScore.team1) msg = 'ВЫ ПРОИГРАЛИ! 😭';
        else msg = 'Ничья!';
    }
    setTimeout(() => {
        alert(`${msg}\nИтоговый счет: ${finalScore.team1} : ${finalScore.team2}${eloChangeMsg}`);
        location.reload();
    }, 500);
});

// === ЧАТ ===
let chatTimeout;
function toggleChat() {
    if (chatContainer.style.display === 'none') {
        chatContainer.style.display = 'flex'; chatToggleBtn.innerText = '👁️';
        chatToggleBtn.classList.remove('chat-hidden'); wakeUpChat();
    } else {
        chatContainer.style.display = 'none'; chatToggleBtn.innerText = '🙈';
        chatToggleBtn.classList.add('chat-hidden');
    }
}
function wakeUpChat() {
    if (chatContainer.style.display === 'none') return;
    chatContainer.style.opacity = '1'; clearTimeout(chatTimeout);
    chatTimeout = setTimeout(() => {
        if (document.activeElement !== document.getElementById('chat-input'))
            chatContainer.style.opacity = '0.3';
    }, 4000);
}
document.getElementById('chat-input').addEventListener('focus', () => { chatContainer.style.opacity = '1'; clearTimeout(chatTimeout); });
document.getElementById('chat-input').addEventListener('blur', wakeUpChat);
function sendChat() {
    const input = document.getElementById('chat-input'), text = input.value.trim();
    if (text && currentRoom) {
        const senderName = isSpectator ? `[Зритель] ${myUsername}` : myUsername;
        socket.emit('chatMessage', { roomId: currentRoom, sender: senderName, text });
        input.value = '';
    }
}
document.getElementById('chat-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });
socket.on('chatMessage', (data) => {
    if (chatContainer.style.display !== 'none') wakeUpChat();
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML += `<div><b>${data.sender}:</b> ${data.text}</div>`;
    msgs.scrollTop = msgs.scrollHeight;
});

// === ВВЕДЕННЯ (МИШКА / ТАЧ) ===
function getEventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    let clientX = e.clientX, clientY = e.clientY;
    if (e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}
function sendInput(pos, dragging) {
    if (isSpectator || !currentRoom) return;
    socket.emit('input', { roomId: currentRoom, dragging, tx: pos ? pos.x : null, ty: pos ? pos.y : null });
}
function handleStart(e) {
    if (isSpectator) return;
    if (e.target.closest('#chat-container') || e.target.closest('#chat-toggle-btn')) return;
    const pos = getEventPos(e), myPlayer = gameState.players[socket.id];
    if (!myPlayer) return;
    const dx = pos.x - myPlayer.x, dy = pos.y - myPlayer.y;
    if (Math.sqrt(dx*dx + dy*dy) <= PLAYER_RADIUS * 1.5) { isDragging = true; sendInput(pos, true); }
}
function handleEnd()    { if (isDragging) { isDragging = false; sendInput(null, false); } }
function handleMove(e)  { if (!isDragging) return; if (e.cancelable) e.preventDefault(); sendInput(getEventPos(e), true); }

canvas.addEventListener('mousedown',  handleStart);
window.addEventListener('mouseup',    handleEnd);
canvas.addEventListener('mousemove',  handleMove);
canvas.addEventListener('touchstart', handleStart, { passive: false });
window.addEventListener('touchend',   handleEnd);
canvas.addEventListener('touchmove',  handleMove,  { passive: false });

// === МАЛЮВАННЯ ===
function safeDrawCircleImage(image, x, y, radius, rotation = 0) {
    if (!image.complete || image.naturalWidth === 0) {
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = 'gray'; ctx.fill(); return;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(rotation);
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
    ctx.drawImage(image, -radius, -radius, radius * 2, radius * 2);
    ctx.restore();
}

function gameLoop(timestamp) {
    if (!currentRoom) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Фон
    if (images.rink.complete) ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);

    // Шайба — інтерполяція
    if (gameState.puck.targetX !== undefined) {
        gameState.puck.x        += (gameState.puck.targetX - gameState.puck.x) * 0.4;
        gameState.puck.y        += (gameState.puck.targetY - gameState.puck.y) * 0.4;
        gameState.puck.rotation += (gameState.puck.targetR - (gameState.puck.rotation || 0)) * 0.4;
    }
    safeDrawCircleImage(images.puck, gameState.puck.x, gameState.puck.y, PUCK_RADIUS, gameState.puck.rotation);

    // Гравці
    for (const id in gameState.players) {
        const p = gameState.players[id];
        if (p.targetX !== undefined) {
            p.x        += (p.targetX - p.x) * 0.4;
            p.y        += (p.targetY - p.y) * 0.4;
            p.rotation += (p.targetR - (p.rotation || 0)) * 0.4;
        }

        const img = images[p.char] || images.korzhik;
        safeDrawCircleImage(img, p.x, p.y, PLAYER_RADIUS, p.rotation);

        // Ім'я та пінг
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.textAlign = 'center';
        ctx.fillStyle = (id === socket.id && !isSpectator) ? '#ffd700' : 'white';
        ctx.font = '14px Arial';
        ctx.fillText(p.isBot ? `[BOT] ${p.username}` : p.username, 0, -PLAYER_RADIUS - 15);
        const ping = p.ping || 0;
        ctx.fillStyle = ping > 150 ? '#ff4d4d' : (ping > 80 ? '#ffd633' : '#00ff00');
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`${ping} ms`, 0, -PLAYER_RADIUS - 2);
        ctx.restore();
    }

    // Рахунок і час
    ctx.fillStyle = 'white'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center';
    ctx.fillText(`${gameState.score.team1} : ${gameState.score.team2}`, canvas.width / 2, 50);
    const min = Math.floor(gameState.timeLeft / 60), sec = gameState.timeLeft % 60;
    ctx.fillStyle = gameState.timeLeft <= 10 ? 'red' : 'yellow';
    ctx.font = 'bold 24px Arial';
    ctx.fillText(`⏱ ${min}:${sec < 10 ? '0' : ''}${sec}`, canvas.width / 2, 85);

    // Анімація голу
    if (showGoalAnimation) {
        const elapsed = timestamp - goalAnimationStart;
        let opacity = Math.min(elapsed / 500, 0.6);
        if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500);
        if (elapsed > 2500) showGoalAnimation = false;

        const flashColor = charColors[goalScorerChar] || '255, 255, 255';
        ctx.fillStyle = `rgba(${flashColor}, ${opacity})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const goalImg = images[`goal_${goalScorerChar}`] || images.goal_korzhik;
        if (goalImg.complete) {
            ctx.globalAlpha = opacity / 0.6;
            ctx.drawImage(goalImg, canvas.width / 2 - 150, canvas.height / 2 - 150, 300, 300);
            ctx.globalAlpha = 1.0;
        }
    }

    // Текст +ЕЛО
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ctx.fillStyle = `rgba(255, 215, 0, ${ft.life / 90})`;
        ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
        ctx.shadowColor = 'black'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ft.y -= 1; ft.life--;
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    requestAnimationFrame(gameLoop);
}
