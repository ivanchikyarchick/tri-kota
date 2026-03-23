const socket = io();
const authDiv = document.getElementById('auth');
const menuDiv = document.getElementById('menu');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusText = document.getElementById('status');
const authStatus = document.getElementById('auth-status');

console.log('[КЛІЄНТ] Скрипт завантажено, чекаємо підключення до сервера...');

let myUsername = '';
let myCharacter = 'korzhik';
let currentRoom = null;
let myTeam = null; 

const PLAYER_RADIUS = 40;
const PUCK_RADIUS = 20;

// Завантаження всіх текстур з логуванням помилок
const images = {
    rink: new Image(), korzhik: new Image(), karamelka: new Image(),
    puck: new Image(), korGol: new Image(), carGol: new Image()
};

function logImageError(name, path) {
    console.error(`[ПОМИЛКА КАРТИНКИ] Не вдалося завантажити: ${name} (шлях: ${path})`);
}

images.rink.onerror = () => logImageError('rink', 'assets/rink.jpg');
images.korzhik.onerror = () => logImageError('korzhik', 'assets/korzhik.png');
images.karamelka.onerror = () => logImageError('karamelka', 'assets/karamelka.png');
images.puck.onerror = () => logImageError('puck', 'assets/puck.png');
images.korGol.onerror = () => logImageError('korGol', 'assets/kor_gol.png');
images.carGol.onerror = () => logImageError('carGol', 'assets/car_gol.png');

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

socket.on('connect', () => {
    console.log('[SOCKET] Підключено до сервера! Мій ID:', socket.id);
});

// === АВТОРИЗАЦІЯ ===
function register() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    console.log(`[АВТОРИЗАЦІЯ] Спроба реєстрації: ${user}`);
    if (user && pass) socket.emit('register', { username: user, password: pass });
}

function login() {
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    console.log(`[АВТОРИЗАЦІЯ] Спроба входу: ${user}`);
    if (user && pass) socket.emit('login', { username: user, password: pass });
}

socket.on('authResult', (res) => {
    console.log('[АВТОРИЗАЦІЯ] Відповідь сервера:', res);
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
    console.log(`[МЕНЮ] Обрано персонажа: ${char}`);
}

function startGame(modePlayers) {
    console.log(`[МЕНЮ] Пошук гри. Режим: ${modePlayers} на ${modePlayers}`);
    socket.emit('findMatch', { character: myCharacter, username: myUsername, mode: modePlayers });
}

socket.on('waiting', (msg) => { 
    console.log('[ПОШУК] Статус:', msg);
    statusText.innerText = msg; 
});

// Приймаємо повний початковий стан
socket.on('matchFound', (data) => {
    console.log('[ГРА] МАТЧ ЗНАЙДЕНО! Дані від сервера:', data);
    try {
        currentRoom = data.roomId;
        gameState = data.state; 
        
        if (!gameState.players[socket.id]) {
            throw new Error('Сервер не надіслав дані мого гравця (socket.id не знайдено в gameState.players)');
        }
        
        myTeam = gameState.players[socket.id].team;
        console.log(`[ГРА] Моя команда: ${myTeam}`);
        
        menuDiv.style.display = 'none';
        canvas.style.display = 'block';
        console.log('[ГРА] Запуск ігрового циклу (gameLoop)...');
        requestAnimationFrame(gameLoop);
    } catch (err) {
        console.error('[КРИТИЧНА ПОМИЛКА] При старті матчу:', err);
        alert('Помилка при старті матчу. Дивіться консоль (F12).');
    }
});

// Приймаємо оптимізований стан
socket.on('gs', (miniState) => {
    if (!currentRoom) return;
    try {
        gameState.puck.x = miniState.u.x;
        gameState.puck.y = miniState.u.y;
        gameState.score = miniState.s;
        
        for (let id in miniState.p) {
            if (gameState.players[id]) {
                gameState.players[id].x = miniState.p[id].x;
                gameState.players[id].y = miniState.p[id].y;
            }
        }
    } catch (err) {
        console.error('[ПОМИЛКА ОНОВЛЕННЯ СТАНУ]', err);
    }
});

socket.on('playerDisconnected', () => {
    console.warn('[ГРА] Хтось відключився.');
    alert('Кто-то из игроков отключился. Матч завершен.');
    location.reload(); 
});

socket.on('goal', (char) => {
    console.log(`[ГОЛ!] Забив: ${char}`);
    goalScorerChar = char;
    showGoalAnimation = true;
    goalAnimationStart = performance.now();
});

// === КЕРУВАННЯ ===
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
    if (Math.sqrt(dx * dx + dy * dy) <= PLAYER_RADIUS * 1.5) {
        isDragging = true;
        console.log('[КЕРУВАННЯ] Гравця захоплено');
    }
}

function handleEnd() { 
    if(isDragging) console.log('[КЕРУВАННЯ] Гравця відпущено');
    isDragging = false; 
}

function handleMove(e) {
    if (e.cancelable) e.preventDefault(); 
    if (!isDragging || !currentRoom) return;
    socket.emit('move', { roomId: currentRoom, position: getEventPos(e) });
}

canvas.addEventListener('mousedown', handleStart);
window.addEventListener('mouseup', handleEnd);
canvas.addEventListener('mousemove', handleMove);

canvas.addEventListener('touchstart', handleStart, { passive: false });
window.addEventListener('touchend', handleEnd);
canvas.addEventListener('touchmove', handleMove, { passive: false });

// === МАЛЮВАННЯ ===
function safeDrawCircleImage(image, x, y, radius) {
    if (!image.complete || image.naturalWidth === 0) {
        // Заглушка, якщо картинка не завантажилась
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); 
        ctx.fillStyle = 'gray'; ctx.fill(); 
        ctx.strokeStyle = 'white'; ctx.stroke();
        return;
    }
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
    ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2); ctx.restore();
}

function gameLoop(timestamp) {
    if (!currentRoom) return;
    
    try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Малюємо поле або світло-блакитний фон (якщо картинки поля немає)
        if (images.rink.complete && images.rink.naturalWidth > 0) {
            ctx.drawImage(images.rink, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = '#e0f7fa'; // Світло-блакитний лід
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#000';
            ctx.font = '20px Arial';
            ctx.fillText('Поле rink.jpg не знайдено!', 50, 50);
        }
        
        // Шайба
        if (!gameState.puck || typeof gameState.puck.x !== 'number') throw new Error('Немає координат шайби');
        safeDrawCircleImage(images.puck, gameState.puck.x, gameState.puck.y, PUCK_RADIUS);
        
        // Гравці
        if (!gameState.players) throw new Error('Обєкт players відсутній');
        for (let id in gameState.players) {
            let p = gameState.players[id];
            if (!p || typeof p.x !== 'number') continue;

            let img = p.char === 'korzhik' ? images.korzhik : images.karamelka;
            safeDrawCircleImage(img, p.x, p.y, PLAYER_RADIUS);
            
            ctx.fillStyle = 'white'; ctx.font = '14px Arial'; ctx.textAlign = 'center';
            ctx.fillText(p.username || 'Гравець', p.x, p.y - PLAYER_RADIUS - 5);
        }

        // Рахунок
        ctx.fillStyle = 'white'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center';
        ctx.fillText(`${gameState.score.team1 || 0} : ${gameState.score.team2 || 0}`, canvas.width / 2, 50);

        // Анімація голу
        if (showGoalAnimation) {
            const elapsed = timestamp - goalAnimationStart;
            let opacity = Math.min(elapsed / 500, 0.6); 
            if (elapsed > 2000) opacity = Math.max(0, 0.6 - (elapsed - 2000) / 500);
            if (elapsed > 2500) showGoalAnimation = false;

            ctx.fillStyle = goalScorerChar === 'korzhik' ? `rgba(0, 100, 255, ${opacity})` : `rgba(255, 105, 180, ${opacity})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const goalImg = goalScorerChar === 'korzhik' ? images.korGol : images.carGol;
            if (goalImg.complete && goalImg.naturalWidth > 0) {
                ctx.globalAlpha = opacity / 0.6; 
                ctx.drawImage(goalImg, canvas.width / 2 - 150, canvas.height / 2 - 150, 300, 300);
                ctx.globalAlpha = 1.0; 
            }
        }

        requestAnimationFrame(gameLoop);

    } catch (err) {
        console.error('[ПОМИЛКА РЕНДЕРУ В GAMELOOP]', err);
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = '20px Arial';
        ctx.fillText('КРИТИЧНА ПОМИЛКА: ' + err.message, 50, 50);
        ctx.fillText('Дивіться консоль (F12)', 50, 80);
        // Не викликаємо requestAnimationFrame, зупиняємо цикл
    }
}
