const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

const WIDTH = 1200, HEIGHT = 600;
const PLAYER_RADIUS = 40, PUCK_RADIUS = 20;
const FRICTION = 0.985, GOAL_HEIGHT = 150, WALL_PADDING = 25; 

const usersDb = {}; 
const rooms = {};
const queues = { 1: [], 2: [], 3: [] };
let totalOnline = 0; 
const ipConnections = {};

function initGameState() {
    return { players: {}, puck: { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0, vr: 0, lastHit: null }, score: { team1: 0, team2: 0 }, goalTriggered: false };
}

// === НОВА НЬЮТОНІВСЬКА ФІЗИКА (Імпульс + Обертання) ===
function applyPhysics(obj1, obj2, r1, r2, mass1, mass2, bounciness) {
    if (!obj1 || !obj2 || isNaN(obj1.x) || isNaN(obj2.x)) return false;
    
    let dx = obj2.x - obj1.x; 
    let dy = obj2.y - obj1.y;
    let dist = Math.sqrt(dx*dx + dy*dy);
    if (dist === 0) { dx = 0.1; dist = 0.1; }
    let minDist = r1 + r2;

    if (dist < minDist) {
        // 1. Виштовхуємо об'єкти один з одного (щоб не застрягали)
        let overlap = minDist - dist;
        let nx = dx / dist, ny = dy / dist;
        let totalMass = mass1 + mass2;
        
        obj1.x -= nx * overlap * (mass2 / totalMass); obj1.y -= ny * overlap * (mass2 / totalMass);
        obj2.x += nx * overlap * (mass1 / totalMass); obj2.y += ny * overlap * (mass1 / totalMass);

        // 2. Розрахунок сили удару (Збереження імпульсу)
        obj1.vx = obj1.vx || 0; obj1.vy = obj1.vy || 0; obj1.vr = obj1.vr || 0;
        obj2.vx = obj2.vx || 0; obj2.vy = obj2.vy || 0; obj2.vr = obj2.vr || 0;
        
        let kx = obj1.vx - obj2.vx; 
        let ky = obj1.vy - obj2.vy;
        let p = 2 * (nx * kx + ny * ky) / totalMass;

        obj1.vx -= p * mass2 * bounciness * nx; obj1.vy -= p * mass2 * bounciness * ny;
        obj2.vx += p * mass1 * bounciness * nx; obj2.vy += p * mass1 * bounciness * ny;

        // 3. Додаємо реалістичне закручування (Torque) по дотичній
        let tangent = -nx * ky + ny * kx;
        obj1.vr += tangent * 0.05 * (mass2 / totalMass);
        obj2.vr -= tangent * 0.05 * (mass1 / totalMass);

        return true;
    }
    return false;
}

function resetAfterGoal(roomId, scorerChar) {
    const game = rooms[roomId]; if (!game) return;
    io.to(roomId).emit('goal', scorerChar);
    setTimeout(() => {
        if(game && game.state) {
            game.state.puck = { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0, vr: 0, lastHit: null };
            game.state.goalTriggered = false; let t1Count = 0, t2Count = 0;
            for (let id in game.state.players) {
                let p = game.state.players[id];
                p.vx = 0; p.vy = 0; p.vr = 0; p.isDragging = false; // Скидаємо швидкості
                if (p.team === 1) { p.x = 150 + (t1Count * 50); p.y = 300 + (t1Count * 50); t1Count++; } 
                else { p.x = 1050 - (t2Count * 50); p.y = 300 + (t2Count * 50); t2Count++; }
            }
        }
    }, 2500);
}

function giveInstantElo(roomId, scoringTeam, lastHitId) {
    const game = rooms[roomId]; if (!game) return;
    for (let id in game.state.players) {
        let p = game.state.players[id]; let dbUser = usersDb[p.username]; if (!dbUser || p.isBot) continue;
        if (id === lastHitId && p.team === scoringTeam) { dbUser.elo += 25; io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 25, reason: 'ГОЛ!' }); } 
        else if (p.team === scoringTeam) { dbUser.elo += 10; io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 10, reason: 'КОМАНДА' }); }
    }
}

function updateElo(roomId, finalScore) {
    const game = rooms[roomId]; if (!game || game.eloAwarded) return; game.eloAwarded = true;
    for (let id in game.state.players) {
        let p = game.state.players[id]; let dbUser = usersDb[p.username]; if (!dbUser || p.isBot) continue;
        let eloChange = 0;
        if (finalScore.team1 === finalScore.team2) eloChange = 0; 
        else if ((p.team === 1 && finalScore.team1 > finalScore.team2) || (p.team === 2 && finalScore.team2 > finalScore.team1)) eloChange = +15; 
        else eloChange = -15; 
        dbUser.elo += eloChange; if (dbUser.elo < 0) dbUser.elo = 0;
        io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: eloChange });
    }
}

function startGameLoop(roomId) {
    const game = rooms[roomId];
    if (game.loopInterval) return;

    game.loopInterval = setInterval(() => {
        try {
            if (!rooms[roomId]) return; 
            let remainingSeconds = Math.max(0, Math.ceil((game.endTime - Date.now()) / 1000));
            if (remainingSeconds === 0) {
                clearInterval(game.loopInterval); updateElo(roomId, game.state.score); 
                io.to(roomId).emit('gameOver', game.state.score); delete rooms[roomId]; return;
            }

            const state = game.state; const puck = state.puck; let hit = false; 

            if (isNaN(puck.x) || isNaN(puck.y) || Math.abs(puck.x) > 4000) { puck.x = WIDTH / 2; puck.y = HEIGHT / 2; puck.vx = 0; puck.vy = 0; }

            puck.x += puck.vx; puck.y += puck.vy;
            puck.rotation = (puck.rotation || 0) + (puck.vr || 0);
            puck.vx *= FRICTION; puck.vy *= FRICTION; puck.vr *= 0.98;

            // Відбивання шайби від стін (з додаванням обертання)
            if (puck.y - PUCK_RADIUS < WALL_PADDING) { puck.y = PUCK_RADIUS + WALL_PADDING; puck.vy *= -0.9; puck.vr += puck.vx * 0.05; hit = true; } 
            else if (puck.y + PUCK_RADIUS > HEIGHT - WALL_PADDING) { puck.y = HEIGHT - PUCK_RADIUS - WALL_PADDING; puck.vy *= -0.9; puck.vr -= puck.vx * 0.05; hit = true; }

            if (puck.y > HEIGHT / 2 - GOAL_HEIGHT / 2 && puck.y < HEIGHT / 2 + GOAL_HEIGHT / 2) {
                if (puck.x - PUCK_RADIUS < WALL_PADDING && !state.goalTriggered) { state.score.team2++; state.goalTriggered = true; giveInstantElo(roomId, 2, puck.lastHit); resetAfterGoal(roomId, 'karamelka'); } 
                else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING && !state.goalTriggered) { state.score.team1++; state.goalTriggered = true; giveInstantElo(roomId, 1, puck.lastHit); resetAfterGoal(roomId, 'korzhik'); }
            } else {
                if (puck.x - PUCK_RADIUS < WALL_PADDING) { puck.x = PUCK_RADIUS + WALL_PADDING; puck.vx *= -0.9; puck.vr += puck.vy * 0.05; hit = true; } 
                else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING) { puck.x = WIDTH - PUCK_RADIUS - WALL_PADDING; puck.vx *= -0.9; puck.vr -= puck.vy * 0.05; hit = true; }
            }
            if (state.goalTriggered) { puck.vx *= 0.5; puck.vy *= 0.5; }

            let now = Date.now();
            let playerKeys = Object.keys(state.players);

            for (let i = 0; i < playerKeys.length; i++) {
                let id = playerKeys[i];
                let p = state.players[id];
                if (!p.isBot && now - p.lastMoveTime > 15000) { p.isBot = true; io.to(id).emit('afkWarning'); }

                p.vx = p.vx || 0; p.vy = p.vy || 0; p.vr = p.vr || 0;

                // Бот логіка
                if (p.isBot && !state.goalTriggered) {
                    let targetX = p.team === 1 ? 200 : WIDTH - 200, targetY = HEIGHT / 2;
                    if ((p.team === 1 && puck.x < WIDTH / 2 + 100) || (p.team === 2 && puck.x > WIDTH / 2 - 100)) { targetX = puck.x; targetY = puck.y; }
                    p.tx = targetX; p.ty = targetY; p.isDragging = true;
                }
                
                // РУХ ГРАВЦЯ
                if (p.isDragging && p.tx !== undefined && p.ty !== undefined) {
                    p.vx += (p.tx - p.x) * 0.15; // Пружина до мишки
                    p.vy += (p.ty - p.y) * 0.15;
                    p.vr *= 0.8; // Гасимо обертання, коли тримаємо
                } else {
                    p.vx *= 0.94; p.vy *= 0.94; p.vr *= 0.96; // Ковзання та кружляння
                }

                p.x += p.vx; p.y += p.vy;
                p.rotation = (p.rotation || 0) + p.vr;

                let minX = p.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS; let maxX = p.team === 1 ? WIDTH / 2 - PLAYER_RADIUS : WIDTH - WALL_PADDING - PLAYER_RADIUS;
                if(p.x < minX) { p.x = minX; p.vx *= -0.5; } if(p.x > maxX) { p.x = maxX; p.vx *= -0.5; }
                if(p.y < WALL_PADDING + PLAYER_RADIUS) { p.y = WALL_PADDING + PLAYER_RADIUS; p.vy *= -0.5; } if(p.y > HEIGHT - WALL_PADDING - PLAYER_RADIUS) { p.y = HEIGHT - WALL_PADDING - PLAYER_RADIUS; p.vy *= -0.5; }

                // Зіткнення: Гравець і Шайба (Гравець маса=4, Шайба маса=1, Bounciness=1.6)
                if (applyPhysics(p, puck, PLAYER_RADIUS, PUCK_RADIUS, 4, 1, 1.6)) { hit = true; puck.lastHit = id; }

                // Зіткнення: Гравець і Гравець (Маси однакові 4 і 4, Bounciness=0.8)
                for (let j = i + 1; j < playerKeys.length; j++) {
                    let p2 = state.players[playerKeys[j]];
                    applyPhysics(p, p2, PLAYER_RADIUS, PLAYER_RADIUS, 4, 4, 0.8);
                }
            }

            // Передаємо лише найнеобхідніше для оптимізації
            const miniState = { p: {}, u: { x: Math.round(puck.x), y: Math.round(puck.y), r: puck.rotation }, s: state.score, t: remainingSeconds, h: hit ? 1 : 0 };
            for (let id in state.players) {
                if (state.players[id] && !isNaN(state.players[id].x)) {
                    miniState.p[id] = { x: Math.round(state.players[id].x), y: Math.round(state.players[id].y), r: state.players[id].rotation || 0, ping: state.players[id].ping || 0, isBot: state.players[id].isBot };
                }
            }
            io.to(roomId).emit('gs', miniState); 

        } catch (err) { console.error("КРАШ УНИКНЕНО:", err); }
    }, 1000 / 30); 
}

setInterval(() => { io.emit('pingTimer', Date.now()); }, 2000);

io.on('connection', (socket) => {
    let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (typeof ip === 'string') ip = ip.split(',')[0].trim(); 
    if (!ipConnections[ip]) ipConnections[ip] = 0; ipConnections[ip]++;
    if (ipConnections[ip] > 15) { socket.disconnect(true); return; }

    totalOnline++; io.emit('onlineCount', totalOnline);

    socket.on('register', ({ username, password }) => {
        if (usersDb[username]) return socket.emit('authResult', { success: false, msg: 'Имя уже занято!' });
        usersDb[username] = { password: password, elo: 1000 }; socket.emit('authResult', { success: true, username, elo: 1000 });
    });

    socket.on('login', ({ username, password }) => {
        let user = usersDb[username];
        if (user && user.password === password) socket.emit('authResult', { success: true, username, elo: user.elo });
        else socket.emit('authResult', { success: false, msg: 'Неверный логин или пароль!' });
    });

    socket.on('findMatch', (data) => {
        try {
            const mode = data.mode; const queue = queues[mode];
            if (!queue.find(p => p.socket.id === socket.id)) queue.push({ socket, data });

            if (queue.length >= mode * 2) {
                const playersInMatch = queue.splice(0, mode * 2); const roomId = `room_${Date.now()}`; const gameState = initGameState();
                playersInMatch.forEach((p, index) => {
                    p.socket.join(roomId); const team = (index < mode) ? 1 : 2; 
                    gameState.players[p.socket.id] = { x: team === 1 ? 150 : 1050, y: 300 + (index * 20), char: p.data.character, team: team, username: p.data.username, ping: 0, lastMoveTime: Date.now(), isBot: false, isDragging: false };
                });
                rooms[roomId] = { state: gameState, players: playersInMatch.map(p => p.socket.id), endTime: Date.now() + 180 * 1000, eloAwarded: false };
                io.to(roomId).emit('matchFound', { roomId, state: gameState }); startGameLoop(roomId);
            } else { socket.emit('waiting', `Ожидание игроков (${queue.length}/${mode * 2})...`); }
        } catch(err) {}
    });

    socket.on('cancelMatchMatchmaking', () => { [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); }); });
    socket.on('spectateRandom', () => {
        const activeRoomsIds = Object.keys(rooms); if (activeRoomsIds.length === 0) { socket.emit('spectateError', 'Сейчас нет активных игр 😔'); return; }
        const randomRoomId = activeRoomsIds[Math.floor(Math.random() * activeRoomsIds.length)];
        socket.join(randomRoomId); socket.emit('spectateStart', { roomId: randomRoomId, state: rooms[randomRoomId].state });
    });

    // ОПТИМІЗОВАНИЙ ВВІД КОРИСТУВАЧА
    socket.on('input', (data) => {
        try {
            if (!data || !data.roomId || !rooms[data.roomId]) return;
            const player = rooms[data.roomId].state.players[socket.id];
            if (player && !player.isBot) { 
                player.lastMoveTime = Date.now();
                player.isDragging = data.dragging;
                if (data.dragging) {
                    player.tx = Number(data.tx); player.ty = Number(data.ty);
                }
            }
        } catch(err) {}
    });

    socket.on('pongTimer', (timestamp) => { for (let roomId in rooms) { let p = rooms[roomId].state.players[socket.id]; if (p) { p.ping = Date.now() - timestamp; break; } } });
    socket.on('chatMessage', (data) => { if (rooms[data.roomId]) io.to(data.roomId).emit('chatMessage', { sender: data.sender, text: data.text }); });

    socket.on('disconnect', () => {
        ipConnections[ip]--; totalOnline--; io.emit('onlineCount', totalOnline);
        [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); });
        for (const roomId in rooms) { if (rooms[roomId].players.includes(socket.id)) { if(rooms[roomId].state.players[socket.id]) { rooms[roomId].state.players[socket.id].isBot = true; } } }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
