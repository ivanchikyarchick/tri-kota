const socket = io();

const authDiv = document.getElementById('auth');
const menuDiv = document.getElementById('menu');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const authStatus = document.getElementById('auth-status');
const chatContainer = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const mmOverlay = document.getElementById('matchmaking-overlay');
const mmText = document.getElementById('mm-text');
const eloDisplay = document.getElementById('my-elo-display');
const afkScreen = document.getElementById('afk-screen');

let myUsername = '';
let myElo = 1000;
let myCharacter = 'korzhik';
let mySelectedMode = 1;
let currentRoom = null;
let myTeam = null; 
let isSpectator = false; 

const PLAYER_RADIUS = 40, PUCK_RADIUS = 20, WALL_PADDING = 25;

const images = { rink: new Image(), korzhik: new Image(), karamelka: new Image(), puck: new Image(), korGol: new Image(), carGol: new Image() };
images.rink.src = 'assets/rink.jpg'; images.korzhik.src = 'assets/korzhik.png'; images.karamelka.src = 'assets/karamelka.png'; 
images.puck.src = 'assets/puck.png'; images.korGol.src = 'assets/kor_gol.png'; images.carGol.src = 'assets/car_gol.png';

const hitSounds = [new Audio('assets/shay1.mp3'), new Audio('assets/shay2.mp3')];

let gameState = { players: {}, puck: { x: 600, y: 300 }, score: { team1: 0, team2: 0 }, timeLeft: 180 };
let isDragging = false, showGoalAnimation = false, goalScorerChar = null, goalAnimationStart = 0;
let floatingTexts = [];

// ЗМІННІ ДЛЯ ФІЗИКИ МИШКІ/ТАЧА
let targetMouseX = 0;
let targetMouseY = 0;

socket.on('onlineCount', (count) => { document.getElementById('online-counter').innerText = `Онлайн: ${count}`; });
socket.on('pingTimer', (timestamp) => { socket.emit('pongTimer', timestamp); });

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
    } else { authStatus.innerText = res.msg; authStatus.style.color = 'red'; }
});

function selectCharacter(char) {
    myCharacter = char; document.querySelectorAll('.char-btn').forEach(btn => btn.classList.remove('active-btn')); document.getElementById(`btn-${char}`).classList.add('active-btn');
}
function selectMode(mode) {
    mySelectedMode = mode; document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active-btn')); document.getElementById(`btn-mode-${mode}`).classList.add('active-btn');
}
function startMatchmaking() {
    mmOverlay.style.display = 'flex'; mmText.innerText = `Ищем игру ${mySelectedMode} на ${mySelectedMode}...`;
    socket.emit('findMatch', { character: myCharacter, username: myUsername, mode: mySelectedMode });
}
function cancelMatchmaking() { socket.emit('cancelMatchMatchmaking'); mmOverlay.style.display = 'none'; }
function spectateRandomGame() { socket.emit('spectateRandom'); }

socket.on('waiting', (msg) => { mmText.innerText = msg; });

socket.on('matchFound', (data) => {
    isSpectator = false; currentRoom = data.roomId; gameState = data.state; myTeam = gameState.players[socket.id].team;
    mmOverlay.style.display = 'none'; menuDiv.style.display = 'none'; canvas.style.display = 'block'; 
    chatContainer.style.display = 'flex'; if(chatToggleBtn) chatToggleBtn.style.display = 'flex'; wakeUpChat();
    requestAnimationFrame(gameLoop);
});

socket.on('spectateStart', (data) => {
    isSpectator = true; currentRoom = data.roomId; gameState = data.state; myTeam = null; 
    mmOverlay.style.display = 'none'; menuDiv.style.display = 'none'; canvas.style.display = 'block'; 
    chatContainer.style.display = 'flex'; if(chatToggleBtn) chatToggleBtn.style.display = 'flex'; wakeUpChat();
    requestAnimationFrame(gameLoop);
    alert('Вы подключились как зритель! 👁️');
});

socket.on('spectateError', (msg) => { alert(msg); });
socket.on('afkWarning', () => { isSpectator = true; if(afkScreen) afkScreen.style.display = 'flex'; });

socket.on('gs', (miniState) => {
    if (!currentRoom) return;
    gameState.puck.targetX = miniState.u.x; gameState.puck.targetY = miniState.u.y; gameState.score = miniState.s; gameState.timeLeft = miniState.t; 
    
    for (let id in miniState.p) {
        if (gameState.players[id]) {
            gameState.players[id].targetX = miniState.p[id].x; 
            gameState.players[id].targetY = miniState.p[id].y;
            gameState.players[id].ping = miniState.p[id].ping; 
            gameState.players[id].isBot = miniState.p[id].isBot; 
        }
    }

    if (miniState.h === 1) {
        let snd = hitSounds[Math.floor(Math.random() * hitSounds.length)];
        snd.currentTime = 0; snd.play().catch(e => {}); 
    }
});

let eloChangeMsg = ""; 
socket.on('eloUpdated', (data) => {
    myElo = data.elo;
    if (eloDisplay) eloDisplay.innerText = `🏆 Рейтинг Эло: ${myElo}`;
    if (data.change > 0 && gameState.players[socket.id] && canvas.style.display === 'block') {
        let p = gameState.players[socket.id];
        floatingTexts.push({ x: p.x, y: p.y - 60, text: `+${data.change} ЭЛО!`, life: 90 });
    }
    if (data.change !== 25 && data.change !== 10) eloChangeMsg = `\nЭло за матч: ${data.change > 0 ? '+' : ''}${data.change} (Всего: ${myElo})`;
});

socket.on('gameOver', (finalScore) => {
    let msg = "Матч окончен!";
    if (!isSpectator && afkScreen.style.display !== 'flex') {
        if (myTeam === 1 && finalScore.team1 > finalScore.team2) msg = "ВЫ ПОБЕДИЛИ! 🎉";
        else if (myTeam === 1 && finalScore.team1 < finalScore.team2) msg = "ВЫ ПРОИГРАЛИ! 😭";
        else if (myTeam === 2 && finalScore.team2 > finalScore.team1) msg = "ВЫ ПОБЕДИЛИ! 🎉";
        else if (myTeam === 2 && finalScore.team2 < finalScore.team1) msg = "ВЫ ПРОИГРАЛИ! 😭";
        else msg = "Ничья!";
    }
    setTimeout(() => { alert(`${msg}\nИтоговый счет: ${finalScore.team1} : ${finalScore.team2}${eloChangeMsg}`); location.reload(); }, 500);
});

socket.on('playerDisconnected', () => {});
socket.on('goal', (char) => { goalScorerChar = char; showGoalAnimation = true; goalAnimationStart = performance.now(); });

let chatTimeout;
function toggleChat() {
    if (chatContainer.style.display === 'none') { chatContainer.style.display = 'flex'; chatToggleBtn.innerText = '👁️'; chatToggleBtn.classList.remove('chat-hidden'); wakeUpChat(); } 
    else { chatContainer.style.display = 'none'; chatToggleBtn.innerText = '🙈'; chatToggleBtn.classList.add('chat-hidden'); }
}
function wakeUpChat() {
    if (chatContainer.style.display === 'none') return; chatContainer.style.opacity = '1'; clearTimeout(chatTimeout);
    chatTimeout = setTimeout(() => { if (document.activeElement !== document.getElementById('chat-input')) chatContainer.style.opacity = '0.3'; }, 4000);
}
document.getElementById('chat-input').addEventListener('focus', () => { chatContainer.style.opacity = '1'; clearTimeout(chatTimeout); });
document.getElementById('chat-input').addEventListener('blur', wakeUpChat);
function sendChat() {
    const input = document.getElementById('chat-input'); const text = input.value.trim();
    if (text && currentRoom) { 
        let senderName = isSpectator ? `[Зритель] ${myUsername}` : myUsername;
        socket.emit('chatMessage', { roomId: currentRoom, sender: senderName, text: text }); input.value = ''; 
    }
}
document.getElementById('chat-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') sendChat(); });
socket.on('chatMessage', (data) => { if (chatContainer.style.display !== 'none') wakeUpChat(); const msgs = document.getElementById('chat-messages'); msgs.innerHTML += `<div><b>${data.sender}:</b> ${data.text}</div>`; msgs.scrollTop = msgs.scrollHeight; });

function getEventPos(e) {
    const rect = canvas.getBoundingClientRect(), scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height; let clientX = e.clientX, clientY = e.clientY;
    if (e.touches && e.touches.length > 0) { clientX = e.touches[0].clientX; clientY = e.touches[0].clientY; }
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function handleStart(e) {
    if (isSpectator) return; if (e.target.closest('#chat-container') || e.target.closest('#chat-toggle-btn')) return; 
    if (!currentRoom || !myTeam || !gameState.players[socket.id]) return;
    const pos = getEventPos(e), myPlayer = gameState.players[socket.id], dx = pos.x - myPlayer.x, dy = pos.y - myPlayer.y;
    
    if (Math.sqrt(dx * dx + dy * dy) <= PLAYER_RADIUS * 1.5) {
        isDragging = true;
        targetMouseX = pos.x;
        targetMouseY = pos.y;
    }
}

function handleEnd() { 
    isDragging = false; 
}

function handleMove(e) {
    if (isSpectator || !isDragging || !currentRoom) return; 
    if (e.target.closest('#chat-container') || e.target.closest('#chat-toggle-btn')) return; 
    if (e.cancelable) e.preventDefault(); 
    
    const pos = getEventPos(e);
    targetMouseX = pos.x;
    targetMouseY = pos.y;
}

canvas.addEventListener('mousedown', handleStart); window.addEventListener('mouseup', handleEnd); canvas.addEventListener('mousemove', handleMove);
canvas.addEventListener('touchstart', handleStart, { passive: false }); window.addEventListener('touchend', handleEnd); canvas.addEventListener('touchmove', handleMove, { passive: false });

// === ОНОВЛЕНА ФУНКЦІЯ МАЛЮВАННЯ З ПІДТРИМКОЮ ОБЕРТАННЯ ===
function safeDrawCircleImage(image, x, y, radius, rotation = 0) {
    if (!image.complete || image.naturalWidth === 0) { ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = 'gray'; ctx.fill(); return; }
    
    ctx.save(); 
    ctx.translate(x, y); // Переносимо центр координат в центр гравця/шайби
    ctx.rotate(rotation); // Крутимо полотно
    
    ctx.beginPath(); 
    ctx.arc(0, 0, radius, 0, Math.PI * 2, true); 
    ctx.closePath(); 
    ctx.clip(); 
    ctx.drawImage(image, -radius, -radius, radius * 2, radius * 2); 
    
    ctx.restore(); // Повертаємо полотно в норму
}

function gameLoop(timestamp) {
    if (!currentRoom) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (images.rink.complete) ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);
    
    if (gameState.puck.targetX !== undefined) {
        gameState.puck.x += (gameState.puck.targetX - gameState.puck.x) * 0.3;
        gameState.puck.y += (gameState.puck.targetY - gameState.puck.y) * 0.3;
    }
    safeDrawCircleImage(images.puck, gameState.puck.x, gameState.puck.y, PUCK_RADIUS);
    
    for (let id in gameState.players) {
        let p = gameState.players[id];
        
        // Ініціалізуємо змінні фізики, якщо їх ще немає
        if (p.vx === undefined) { p.vx = 0; p.vy = 0; p.rotation = 0; p.vr = 0; }

        if (id === socket.id && !isSpectator) {
            // === ФІЗИКА ЛОКАЛЬНОГО ГРАВЦЯ ===
            if (isDragging) {
                // Пружинимо до мишки
                p.vx = (targetMouseX - p.x) * 0.25;
                p.vy = (targetMouseY - p.y) * 0.25;
                p.vr *= 0.8; // Перестаємо крутитися, коли нас тримають
            } else {
                // Ковзаємо по інерції
                p.vx *= 0.95; 
                p.vy *= 0.95;
                
                // Додаємо кружляння, якщо швидко ковзаємо
                let speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
                if (speed > 2) {
                    p.vr = (p.vx > 0 ? 1 : -1) * speed * 0.02; // Крутимось в бік польоту
                } else {
                    p.vr *= 0.9; // Зупиняємо обертання
                }
            }

            // Застосовуємо швидкість до координат
            p.x += p.vx;
            p.y += p.vy;

            // Не вилітаємо за межі (локально)
            let minX = myTeam === 1 ? WALL_PADDING + PLAYER_RADIUS : canvas.width / 2 + PLAYER_RADIUS;
            let maxX = myTeam === 1 ? canvas.width / 2 - PLAYER_RADIUS : canvas.width - WALL_PADDING - PLAYER_RADIUS;
            let minY = WALL_PADDING + PLAYER_RADIUS, maxY = canvas.height - WALL_PADDING - PLAYER_RADIUS;
            
            p.x = Math.max(minX, Math.min(p.x, maxX)); 
            p.y = Math.max(minY, Math.min(p.y, maxY));
            
            // Відправляємо рух на сервер, якщо рухаємось
            if (Math.abs(p.vx) > 0.1 || Math.abs(p.vy) > 0.1) {
                socket.emit('move', { roomId: currentRoom, position: {x: p.x, y: p.y} });
            }

        } else if (p.targetX !== undefined) {
            // === ФІЗИКА ІНШИХ ГРАВЦІВ (Анімація їх руху) ===
            let dx = (p.targetX - p.x) * 0.3;
            let dy = (p.targetY - p.y) * 0.3;
            p.x += dx; 
            p.y += dy;
            
            // Якщо інший гравець швидко летить - крутимо і його!
            let speed = Math.sqrt(dx * dx + dy * dy);
            if (speed > 1) { p.vr = (dx > 0 ? 1 : -1) * speed * 0.03; } 
            else { p.vr *= 0.9; }
        }

        // Застосовуємо кут обертання
        p.rotation += p.vr;

        let img = p.char === 'korzhik' ? images.korzhik : images.karamelka;
        
        // Малюємо з обертанням!
        safeDrawCircleImage(img, p.x, p.y, PLAYER_RADIUS, p.rotation);
        
        ctx.fillStyle = (id === socket.id && !isSpectator) ? '#ffd700' : 'white'; 
        ctx.font = '14px Arial'; ctx.textAlign = 'center'; 
        
        let displayName = p.isBot ? `[BOT] ${p.username}` : p.username;
        // Текст малюємо без обертання, щоб він не крутився догори дригом
        ctx.fillText(displayName, p.x, p.y - PLAYER_RADIUS - 15);
        
        let pingVal = p.ping || 0;
        ctx.fillStyle = pingVal > 150 ? '#ff4d4d' : (pingVal > 80 ? '#ffd633' : '#00ff00');
        ctx.font = 'bold 12px Arial'; ctx.fillText(`${pingVal} ms`, p.x, p.y - PLAYER_RADIUS - 2);
    }

    ctx.fillStyle = 'white'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center';
    ctx.fillText(`${gameState.score.team1} : ${gameState.score.team2}`, canvas.width / 2, 50);

    let min = Math.floor(gameState.timeLeft / 60), sec = gameState.timeLeft % 60;
    ctx.fillStyle = gameState.timeLeft <= 10 ? 'red' : 'yellow'; ctx.font = 'bold 24px Arial'; ctx.fillText(`⏱ ${min}:${sec < 10 ? '0' : ''}${sec}`, canvas.width / 2, 85);

    if (showGoalAnimation) {
        const elapsed = timestamp - goalAnimationStart;
        let opacity = Math.min(elapsed / 500, 0.6); if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500); if (elapsed > 2500) showGoalAnimation = false;
        ctx.fillStyle = goalScorerChar === 'korzhik' ? `rgba(0, 100, 255, ${opacity})` : `rgba(255, 105, 180, ${opacity})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const goalImg = goalScorerChar === 'korzhik' ? images.korGol : images.carGol;
        if (goalImg.complete) { ctx.globalAlpha = opacity / 0.6; ctx.drawImage(goalImg, canvas.width / 2 - 150, canvas.height / 2 - 150, 300, 300); ctx.globalAlpha = 1.0; }
    }

    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        let ft = floatingTexts[i];
        ctx.fillStyle = `rgba(255, 215, 0, ${ft.life / 90})`; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
        ctx.shadowColor = "black"; ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ft.y -= 1; ft.life--;
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    requestAnimationFrame(gameLoop);
}
