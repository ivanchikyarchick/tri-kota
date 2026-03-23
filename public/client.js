const socket = io();
const authDiv = document.getElementById('auth');
const menuDiv = document.getElementById('menu');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusText = document.getElementById('status');
const authStatus = document.getElementById('auth-status');

let myUsername = '';
let myCharacter = 'korzhik';
let currentRoom = null;
let myTeam = null; 

const PLAYER_RADIUS = 40;
const PUCK_RADIUS = 20;

// Завантаження всіх текстур
const images = {
    rink: new Image(), korzhik: new Image(), karamelka: new Image(),
    puck: new Image(), korGol: new Image(), carGol: new Image()
};

images.rink.src = 'assets/rink.jpg'; 
images.korzhik.src = 'assets/korzhik.png';
images.karamelka.src = 'assets/karamelka.png'; 
images.puck.src = 'assets/puck.png';
images.korGol.src = 'assets/kor_gol.png'; 
images.carGol.src = 'assets/car_gol.png';

let gameState = { players: {}, puck: { x: 600, y: 300 }, score: { team1: 0, team2: 0 } };
let isDragging = false;
let showGoalAnimation = false;
let goalScorerChar = null;
let goalAnimationStart = 0;

// === АВТОРИЗАЦІЯ ===
function register() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (user && pass) socket.emit('register', { username: user, password: pass });
}

function login() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (user && pass) socket.emit('login', { username: user, password: pass });
}

socket.on('authResult', (res) => {
    if (res.success) {
        myUsername = res.username;
        authDiv.style.display = 'none';
        menuDiv.style.display = 'block';
        document.getElementById('welcome-text').innerText = `Привет, ${myUsername}!`;
    } else {
        authStatus.innerText = res.msg;
        authStatus.style.color = 'red';
    }
});

// === МЕНЮ ТА ГРА ===
function selectCharacter(char) {
    myCharacter = char;
    statusText.innerText = `Выбран: ${char === 'korzhik' ? 'Коржик' : 'Карамелька'}`;
}

function startGame(modePlayers) {
    socket.emit('findMatch', { character: myCharacter, username: myUsername, mode: modePlayers });
}

socket.on('waiting', (msg) => { statusText.innerText = msg; });

// Приймаємо повний початковий стан (імена, команди, хто де стоїть)
socket.on('matchFound', (data) => {
    currentRoom = data.roomId;
    gameState = data.state; 
    myTeam = gameState.players[socket.id].team;
    
    menuDiv.style.display = 'none';
    canvas.style.display = 'block';
    requestAnimationFrame(gameLoop);
});

// Приймаємо ОПТИМІЗОВАНИЙ стан (тільки координати для Render.com)
socket.on('gs', (miniState) => {
    if (!currentRoom) return;
    
    gameState.puck.x = miniState.u.x;
    gameState.puck.y = miniState.u.y;
    gameState.score = miniState.s;
    
    // Оновлюємо лише координати гравців
    for (let id in miniState.p) {
        if (gameState.players[id]) {
            gameState.players[id].x = miniState.p[id].x;
            gameState.players[id].y = miniState.p[id].y;
        }
    }
});

// Якщо суперник вийшов, повертаємо в меню
socket.on('playerDisconnected', () => {
    alert('Кто-то из игроков отключился. Матч завершен.');
    location.reload(); 
});

// Анімація голу
socket.on('goal', (char) => {
    goalScorerChar = char;
    showGoalAnimation = true;
    goalAnimationStart = performance.now();
});

// === КЕРУВАННЯ (МИШКА + ТАЧСКРІН) ===
function getEventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    let clientX = e.clientX;
    let clientY = e.clientY;
    
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    }

    return { 
        x: (clientX - rect.left) * scaleX, 
        y: (clientY - rect.top) * scaleY 
    };
}

function handleStart(e) {
    if (!currentRoom || !myTeam || !gameState.players[socket.id]) return;
    const pos = getEventPos(e);
    const myPlayer = gameState.players[socket.id];
    
    const dx = pos.x - myPlayer.x;
    const dy = pos.y - myPlayer.y;
    // Збільшена зона захвату для зручності на телефонах
    if (Math.sqrt(dx * dx + dy * dy) <= PLAYER_RADIUS * 1.5) {
        isDragging = true;
    }
}

function handleEnd() { 
    isDragging = false; 
}

function handleMove(e) {
    // Зупиняємо скрол сторінки на телефонах при грі
    if (e.cancelable) e.preventDefault(); 
    
    if (!isDragging || !currentRoom) return;
    socket.emit('move', { roomId: currentRoom, position: getEventPos(e) });
}

// Прив'язуємо події
canvas.addEventListener('mousedown', handleStart);
window.addEventListener('mouseup', handleEnd);
canvas.addEventListener('mousemove', handleMove);

canvas.addEventListener('touchstart', handleStart, { passive: false });
window.addEventListener('touchend', handleEnd);
canvas.addEventListener('touchmove', handleMove, { passive: false });

// === МАЛЮВАННЯ ===
function safeDrawCircleImage(image, x, y, radius) {
    if (!image.complete || image.naturalWidth === 0) {
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = 'gray'; ctx.fill(); return;
    }
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
    ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2); ctx.restore();
}

function gameLoop(timestamp) {
    if (!currentRoom) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (images.rink.complete) ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);
    
    safeDrawCircleImage(images.puck, gameState.puck.x, gameState.puck.y, PUCK_RADIUS);
    
    // Малюємо всіх гравців у кімнаті
    for (let id in gameState.players) {
        let p = gameState.players[id];
        let img = p.char === 'korzhik' ? images.korzhik : images.karamelka;
        safeDrawCircleImage(img, p.x, p.y, PLAYER_RADIUS);
        
        // Нікнейм над гравцем
        ctx.fillStyle = 'white'; ctx.font = '14px Arial'; ctx.textAlign = 'center';
        ctx.fillText(p.username, p.x, p.y - PLAYER_RADIUS - 5);
    }

    // Рахунок
    ctx.fillStyle = 'white'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center';
    ctx.fillText(`${gameState.score.team1} : ${gameState.score.team2}`, canvas.width / 2, 50);

    // Плавна анімація голу
    if (showGoalAnimation) {
        const elapsed = timestamp - goalAnimationStart;
        let opacity = Math.min(elapsed / 500, 0.6); 
        if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500);
        if (elapsed > 2500) showGoalAnimation = false;

        ctx.fillStyle = goalScorerChar === 'korzhik' ? `rgba(0, 100, 255, ${opacity})` : `rgba(255, 105, 180, ${opacity})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const goalImg = goalScorerChar === 'korzhik' ? images.korGol : images.carGol;
        if (goalImg.complete) {
            ctx.globalAlpha = opacity / 0.6; 
            ctx.drawImage(goalImg, canvas.width / 2 - 150, canvas.height / 2 - 150, 300, 300);
            ctx.globalAlpha = 1.0; 
        }
    }

    requestAnimationFrame(gameLoop);
}
