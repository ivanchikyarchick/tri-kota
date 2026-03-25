const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static('public'));

// ============================================================
// КОНСТАНТИ
// ============================================================
const WIDTH         = 1200;
const HEIGHT        = 600;
const PLAYER_RADIUS = 40;
const PUCK_RADIUS   = 20;
const FRICTION      = 0.985; // Тертя шайби
const GOAL_HEIGHT   = 150;
const WALL_PADDING  = 25;
const CORNER_RADIUS = 100;
const MAX_PUCK_SPEED = 60;

// ============================================================
// СТАН СЕРВЕРА
// ============================================================
const usersDb       = {};
const rooms         = {};
const queues        = { 1: [], 2: [], 3: [] };
const ipConnections = {};
const playerStats   = {};
let totalOnline     = 0;

function initGameState() {
    return {
        players: {},
        puck: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, vr: 0, rotation: 0, lastHit: null },
        score: { team1: 0, team2: 0 },
        goalTriggered: false,
    };
}

// ============================================================
// ФІЗИКА (для гравців між собою)
// ============================================================
function applyPhysics(obj1, obj2, r1, r2, mass1, mass2, bounciness) {
    if (!obj1 || !obj2 || isNaN(obj1.x) || isNaN(obj2.x)) return false;
    let dx = obj2.x - obj1.x;
    let dy = obj2.y - obj1.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) { dx = 0.1; dist = 0.1; }
    const minDist = r1 + r2;

    if (dist < minDist) {
        const overlap    = minDist - dist;
        const nx         = dx / dist;
        const ny         = dy / dist;
        const totalMass  = mass1 + mass2;

        obj1.x -= nx * overlap * (mass2 / totalMass);
        obj1.y -= ny * overlap * (mass2 / totalMass);
        obj2.x += nx * overlap * (mass1 / totalMass);
        obj2.y += ny * overlap * (mass1 / totalMass);

        obj1.vx = obj1.vx || 0; obj1.vy = obj1.vy || 0; obj1.vr = obj1.vr || 0;
        obj2.vx = obj2.vx || 0; obj2.vy = obj2.vy || 0; obj2.vr = obj2.vr || 0;

        const kx = obj1.vx - obj2.vx;
        const ky = obj1.vy - obj2.vy;
        const p  = 2 * (nx * kx + ny * ky) / totalMass;

        obj1.vx -= p * mass2 * bounciness * nx;
        obj1.vy -= p * mass2 * bounciness * ny;
        obj2.vx += p * mass1 * bounciness * nx;
        obj2.vy += p * mass1 * bounciness * ny;

        return true;
    }
    return false;
}

// ============================================================
// ШІ - ПЕРЕДБАЧЕННЯ ТРАЄКТОРІЇ ТА ЛОГІКА
// ============================================================
function predictPuckPosition(puck, steps) {
    let x = puck.x, y = puck.y, vx = puck.vx, vy = puck.vy;
    for (let i = 0; i < steps; i++) {
        x += vx; y += vy;
        vx *= FRICTION; vy *= FRICTION;
        if (y - PUCK_RADIUS < WALL_PADDING) { y = PUCK_RADIUS + WALL_PADDING; vy *= -0.9; }
        else if (y + PUCK_RADIUS > HEIGHT - WALL_PADDING) { y = HEIGHT - PUCK_RADIUS - WALL_PADDING; vy *= -0.9; }
        if (x - PUCK_RADIUS < WALL_PADDING) { x = PUCK_RADIUS + WALL_PADDING; vx *= -0.9; }
        else if (x + PUCK_RADIUS > WIDTH - WALL_PADDING) { x = WIDTH - PUCK_RADIUS - WALL_PADDING; vx *= -0.9; }
    }
    return { x, y };
}

function trackPlayerBehavior(roomId, playerId) {
    if (!playerStats[playerId]) playerStats[playerId] = { rushCount: 0, prefersTop: 0, lastX: null, lastY: null };
    const game = rooms[roomId];
    if (!game) return;
    const p = game.state.players[playerId];
    if (!p || p.isBot) return;

    const stats = playerStats[playerId];
    if (stats.lastX !== null) {
        const dx = p.x - stats.lastX;
        if (Math.abs(dx) > 2) stats.rushCount++;
        stats.prefersTop += (p.y < HEIGHT / 2) ? 1 : -1;
    }
    stats.lastX = p.x; stats.lastY = p.y;
}

// ============================================================
// ГОЛИ ТА СКИДАННЯ
// ============================================================
function resetAfterGoal(roomId, scorerChar) {
    const game = rooms[roomId];
    if (!game) return;
    io.to(roomId).emit('goal', scorerChar);

    setTimeout(() => {
        if (!game || !game.state) return;
        game.state.puck = { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0, vr: 0, rotation: 0, lastHit: null };
        game.state.goalTriggered = false;
        let t1Count = 0, t2Count = 0;
        for (const id in game.state.players) {
            const p = game.state.players[id];
            p.vx = 0; p.vy = 0; p.vr = 0; p.isDragging = false;
            if (p.team === 1) { p.x = 150 + t1Count * 50; p.y = 300 + t1Count * 50; t1Count++; }
            else              { p.x = 1050 - t2Count * 50; p.y = 300 + t2Count * 50; t2Count++; }
        }
    }, 2500);
}

function giveInstantElo(roomId, scoringTeam, lastHitId) {
    const game = rooms[roomId];
    if (!game) return;
    for (const id in game.state.players) {
        const p = game.state.players[id];
        const dbUser = usersDb[p.username];
        if (!dbUser || p.isBot) continue;
        if (id === lastHitId && p.team === scoringTeam) {
            dbUser.elo += 25; io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 25, reason: 'ГОЛ!' });
        } else if (p.team === scoringTeam) {
            dbUser.elo += 10; io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: 10, reason: 'КОМАНДА' });
        }
    }
}

function updateElo(roomId, finalScore) {
    const game = rooms[roomId];
    if (!game || game.eloAwarded) return;
    game.eloAwarded = true;
    for (const id in game.state.players) {
        const p = game.state.players[id];
        const dbUser = usersDb[p.username];
        if (!dbUser || p.isBot) continue;
        let eloChange = (finalScore.team1 === finalScore.team2) ? 0 : 
                        ((p.team === 1 && finalScore.team1 > finalScore.team2) || (p.team === 2 && finalScore.team2 > finalScore.team1)) ? 15 : -15;
        dbUser.elo = Math.max(0, dbUser.elo + eloChange);
        io.to(id).emit('eloUpdated', { elo: dbUser.elo, change: eloChange });
    }
}

// ============================================================
// ГОЛОВНИЙ ІГРОВИЙ ЦИКЛ (ОНОВЛЕНА ФІЗИКА)
// ============================================================
function startGameLoop(roomId) {
    const game = rooms[roomId];
    if (game.loopInterval) return;

    const LEFT_BOUND = WALL_PADDING + PUCK_RADIUS;
    const RIGHT_BOUND = WIDTH - WALL_PADDING - PUCK_RADIUS;
    const TOP_BOUND = WALL_PADDING + PUCK_RADIUS;
    const BOTTOM_BOUND = HEIGHT - WALL_PADDING - PUCK_RADIUS;

    game.loopInterval = setInterval(() => {
        try {
            if (!rooms[roomId]) return;

            const remainingSeconds = Math.max(0, Math.ceil((game.endTime - Date.now()) / 1000));
            if (remainingSeconds === 0) {
                clearInterval(game.loopInterval);
                updateElo(roomId, game.state.score);
                io.to(roomId).emit('gameOver', game.state.score);
                delete rooms[roomId];
                return;
            }

            const state = game.state;
            const puck  = state.puck;
            let   hit   = false;

            if (isNaN(puck.x) || isNaN(puck.y) || Math.abs(puck.x) > 4000) {
                puck.x = WIDTH / 2; puck.y = HEIGHT / 2; puck.vx = 0; puck.vy = 0;
            }

            const puckSpeed = Math.sqrt(puck.vx ** 2 + puck.vy ** 2);
            if (puckSpeed > MAX_PUCK_SPEED) {
                puck.vx = (puck.vx / puckSpeed) * MAX_PUCK_SPEED;
                puck.vy = (puck.vy / puckSpeed) * MAX_PUCK_SPEED;
            }

            puck.x        += puck.vx;
            puck.y        += puck.vy;
            puck.rotation  = (puck.rotation || 0) + (puck.vr || 0);
            puck.vx       *= FRICTION;
            puck.vy       *= FRICTION;
            puck.vr       *= 0.98;

            // --- БРОНЕБІЙНА ЛОГІКА СТІН ТА ВОРІТ ---
            const inGoalZone = puck.y > HEIGHT / 2 - GOAL_HEIGHT / 2 && puck.y < HEIGHT / 2 + GOAL_HEIGHT / 2;
            
            if (inGoalZone) {
                if (puck.x < LEFT_BOUND && !state.goalTriggered) {
                    state.score.team2++; state.goalTriggered = true; giveInstantElo(roomId, 2, puck.lastHit);
                    const scorerChar = (puck.lastHit && state.players[puck.lastHit]) ? state.players[puck.lastHit].char : 'karamelka';
                    resetAfterGoal(roomId, scorerChar);
                } else if (puck.x > RIGHT_BOUND && !state.goalTriggered) {
                    state.score.team1++; state.goalTriggered = true; giveInstantElo(roomId, 1, puck.lastHit);
                    const scorerChar = (puck.lastHit && state.players[puck.lastHit]) ? state.players[puck.lastHit].char : 'korzhik';
                    resetAfterGoal(roomId, scorerChar);
                }
                
                // Стінки всередині воріт (вирішує проблему "телепортації")
                if (puck.x < LEFT_BOUND || puck.x > RIGHT_BOUND) {
                    const goalTop = HEIGHT / 2 - GOAL_HEIGHT / 2 + PUCK_RADIUS;
                    const goalBot = HEIGHT / 2 + GOAL_HEIGHT / 2 - PUCK_RADIUS;
                    if (puck.y < goalTop) { puck.y = goalTop; if (puck.vy < 0) { puck.vy *= -0.5; hit = true; } }
                    if (puck.y > goalBot) { puck.y = goalBot; if (puck.vy > 0) { puck.vy *= -0.5; hit = true; } }
                    // Задня стінка воріт
                    if (puck.x < WALL_PADDING) { puck.x = WALL_PADDING; if (puck.vx < 0) puck.vx *= -0.5; }
                    if (puck.x > WIDTH - WALL_PADDING) { puck.x = WIDTH - WALL_PADDING; if (puck.vx > 0) puck.vx *= -0.5; }
                }
            } else {
                // Прямі стіни (звук тільки якщо шайба летить В стіну)
                if (puck.x < LEFT_BOUND && puck.y >= TOP_BOUND + CORNER_RADIUS && puck.y <= BOTTOM_BOUND - CORNER_RADIUS) { 
                    puck.x = LEFT_BOUND; if (puck.vx < 0) { puck.vx *= -0.9; puck.vr += puck.vy * 0.05; hit = true; }
                } else if (puck.x > RIGHT_BOUND && puck.y >= TOP_BOUND + CORNER_RADIUS && puck.y <= BOTTOM_BOUND - CORNER_RADIUS) { 
                    puck.x = RIGHT_BOUND; if (puck.vx > 0) { puck.vx *= -0.9; puck.vr -= puck.vy * 0.05; hit = true; }
                }
                
                if (puck.y < TOP_BOUND && puck.x >= LEFT_BOUND + CORNER_RADIUS && puck.x <= RIGHT_BOUND - CORNER_RADIUS) { 
                    puck.y = TOP_BOUND; if (puck.vy < 0) { puck.vy *= -0.9; puck.vr += puck.vx * 0.05; hit = true; }
                } else if (puck.y > BOTTOM_BOUND && puck.x >= LEFT_BOUND + CORNER_RADIUS && puck.x <= RIGHT_BOUND - CORNER_RADIUS) { 
                    puck.y = BOTTOM_BOUND; if (puck.vy > 0) { puck.vy *= -0.9; puck.vr -= puck.vx * 0.05; hit = true; }
                }

                // Закруглені кути
                const corners = [
                    { cx: LEFT_BOUND + CORNER_RADIUS, cy: TOP_BOUND + CORNER_RADIUS },
                    { cx: RIGHT_BOUND - CORNER_RADIUS, cy: TOP_BOUND + CORNER_RADIUS },
                    { cx: LEFT_BOUND + CORNER_RADIUS, cy: BOTTOM_BOUND - CORNER_RADIUS },
                    { cx: RIGHT_BOUND - CORNER_RADIUS, cy: BOTTOM_BOUND - CORNER_RADIUS }
                ];

                for (let corner of corners) {
                    const cdx = puck.x - corner.cx;
                    const cdy = puck.y - corner.cy;
                    const cDist = Math.hypot(cdx, cdy);
                    
                    if (cDist > CORNER_RADIUS && 
                       ((puck.x <= corner.cx && puck.y <= corner.cy) || (puck.x >= corner.cx && puck.y <= corner.cy) || 
                        (puck.x <= corner.cx && puck.y >= corner.cy) || (puck.x >= corner.cx && puck.y >= corner.cy))) {
                        
                        const nx = cdx / (cDist || 1);
                        const ny = cdy / (cDist || 1);
                        puck.x = corner.cx + nx * CORNER_RADIUS;
                        puck.y = corner.cy + ny * CORNER_RADIUS;
                        
                        const dotProduct = puck.vx * nx + puck.vy * ny;
                        if (dotProduct > 0) { // Перевірка, що шайба рухається В стіну
                            puck.vx -= 2 * dotProduct * nx * 0.9;
                            puck.vy -= 2 * dotProduct * ny * 0.9;
                            hit = true;
                        }
                    }
                }
            }

            if (state.goalTriggered) { puck.vx *= 0.5; puck.vy *= 0.5; }

            const playerKeys = Object.keys(state.players);
            const now = Date.now();

            for (let i = 0; i < playerKeys.length; i++) {
                const id = playerKeys[i];
                const p  = state.players[id];

                if (!p.isBot && now - p.lastMoveTime > 15000) { p.isBot = true; io.to(id).emit('afkWarning'); }

                p.vx = p.vx || 0; p.vy = p.vy || 0; p.vr = p.vr || 0;

                // Бот логіка
                if (p.isBot && !state.goalTriggered) {
                    const isTeam1 = p.team === 1;
                    const myGoalX = isTeam1 ? WALL_PADDING + 60 : WIDTH - WALL_PADDING - 60;
                    if (!p._botTick) p._botTick = 0; p._botTick--;
                    if (p._botTick <= 0) {
                        p._tx = puck.x + (isTeam1 ? -55 : 55);
                        p._ty = puck.y + (Math.random() - 0.5) * 35;
                        p._botTick = 18;
                    }
                    p.tx = p._tx; p.ty = p._ty; p.isDragging = true;
                    p._botMoveCfg = { factor: 0.18, maxSpd: 22 };
                }

                // Рух гравця
                if (p.isDragging && p.tx !== undefined && p.ty !== undefined) {
                    const cfg = p.isBot ? (p._botMoveCfg || { factor: 0.18, maxSpd: 22 }) : { factor: 0.25, maxSpd: 60 };
                    p.vx = (p.tx - p.x) * cfg.factor; p.vy = (p.ty - p.y) * cfg.factor; p.vr *= 0.95;
                    const speed = Math.sqrt(p.vx ** 2 + p.vy ** 2);
                    if (speed > cfg.maxSpd) { p.vx = (p.vx / speed) * cfg.maxSpd; p.vy = (p.vy / speed) * cfg.maxSpd; }
                } else {
                    p.vx *= 0.85; p.vy *= 0.85; p.vr *= 0.97;
                    const speed = Math.sqrt(p.vx ** 2 + p.vy ** 2);
                    if (speed > 3) p.vr += (p.vx > 0 ? 1 : -1) * speed * 0.025;
                }

                p.x += p.vx; p.y += p.vy; p.rotation = (p.rotation || 0) + p.vr;

                // Межі гравця
                const minX = p.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS;
                const maxX = p.team === 1 ? WIDTH / 2 - PLAYER_RADIUS    : WIDTH - WALL_PADDING - PLAYER_RADIUS;
                if (p.x < minX) { p.x = minX; p.vx *= -0.5; }
                if (p.x > maxX) { p.x = maxX; p.vx *= -0.5; }
                if (p.y < WALL_PADDING + PLAYER_RADIUS) { p.y = WALL_PADDING + PLAYER_RADIUS; p.vy *= -0.5; }
                if (p.y > HEIGHT - WALL_PADDING - PLAYER_RADIUS) { p.y = HEIGHT - WALL_PADDING - PLAYER_RADIUS; p.vy *= -0.5; }

                // --- НОВА ЛОГІКА: Гравець vs Шайба (Вирішує баг з застряганням і звуком) ---
                const dx = puck.x - p.x;
                const dy = puck.y - p.y;
                const dist = Math.hypot(dx, dy) || 1;
                const minDist = PLAYER_RADIUS + PUCK_RADIUS;

                if (dist < minDist) {
                    const overlap = minDist - dist;
                    const nx = dx / dist;
                    const ny = dy / dist;

                    // Фізично розштовхуємо обох! Це не дає гравцю затиснути шайбу в стіні.
                    puck.x += nx * (overlap * 0.85);
                    puck.y += ny * (overlap * 0.85);
                    p.x -= nx * (overlap * 0.15); // Відкидаємо гравця трішки назад
                    p.y -= ny * (overlap * 0.15);

                    puck.vx += p.vx * 0.8 + nx * 2;
                    puck.vy += p.vy * 0.8 + ny * 2;
                    p.vx -= nx * 0.5;
                    p.vy -= ny * 0.5;

                    // Звук удару відтворюється ТІЛЬКИ при сильному зіткненні
                    if (Math.abs(p.vx) > 1.5 || Math.abs(p.vy) > 1.5 || Math.abs(puck.vx) > 3) {
                        hit = true; 
                    }
                    puck.lastHit = id;
                }

                // Зіткнення між гравцями
                for (let j = i + 1; j < playerKeys.length; j++) {
                    applyPhysics(p, state.players[playerKeys[j]], PLAYER_RADIUS, PLAYER_RADIUS, 4, 4, 0.8);
                }
            }

            const miniState = {
                p: {}, u: { x: Math.round(puck.x), y: Math.round(puck.y), r: puck.rotation },
                s: state.score, t: remainingSeconds, h: hit ? 1 : 0,
            };
            for (const id in state.players) {
                const pl = state.players[id];
                if (pl && !isNaN(pl.x)) {
                    miniState.p[id] = { x: Math.round(pl.x), y: Math.round(pl.y), r: pl.rotation || 0, ping: pl.ping || 0, isBot: pl.isBot };
                }
            }
            io.to(roomId).emit('gs', miniState);

        } catch (err) { console.error('КРАШ УНИКНЕНО:', err); }
    }, 1000 / 30);
}

// ============================================================
// PING ТА SOCKET.IO ПІДКЛЮЧЕННЯ
// ============================================================
setInterval(() => io.emit('pingTimer', Date.now()), 2000);

io.on('connection', (socket) => {
    let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (typeof ip === 'string') ip = ip.split(',')[0].trim();
    if (!ipConnections[ip]) ipConnections[ip] = 0;
    ipConnections[ip]++;
    if (ipConnections[ip] > 15) { socket.disconnect(true); return; }

    totalOnline++; io.emit('onlineCount', totalOnline);

    socket.on('register', ({ username, password }) => {
        if (usersDb[username]) return socket.emit('authResult', { success: false, msg: 'Ім\'я вже зайнято!' });
        usersDb[username] = { password, elo: 1000 };
        socket.emit('authResult', { success: true, userId: username, username, elo: 1000 });
    });

    socket.on('login', ({ username, password }) => {
        const user = usersDb[username];
        if (user && user.password === password) socket.emit('authResult', { success: true, userId: username, username, elo: user.elo });
        else socket.emit('authResult', { success: false, msg: 'Невірний логін або пароль!' });
    });

    socket.on('autoLogin', (userId) => {
        const user = usersDb[userId];
        if (user) socket.emit('authResult', { success: true, userId: userId, username: userId, elo: user.elo });
        else socket.emit('authResult', { success: false, msg: 'Сесія застаріла, увійдіть знову' });
    });
    
    socket.on('findMatch', (data) => {
        try {
            const mode = data.mode; const queue = queues[mode];
            if (!queue.find(p => p.socket.id === socket.id)) queue.push({ socket, data });

            if (queue.length >= mode * 2) {
                const playersInMatch = queue.splice(0, mode * 2);
                const roomId = `room_${Date.now()}`;
                const gameState = initGameState();

                playersInMatch.forEach((p, index) => {
                    p.socket.join(roomId);
                    const team = index < mode ? 1 : 2;
                    gameState.players[p.socket.id] = {
                        x: team === 1 ? 150 : 1050, y: 300 + index * 20,
                        char: p.data.character, team, username: p.data.username,
                        ping: 0, lastMoveTime: Date.now(), isBot: false, isDragging: false,
                    };
                });

                rooms[roomId] = { state: gameState, players: playersInMatch.map(p => p.socket.id), endTime: Date.now() + 180 * 1000, eloAwarded: false };
                io.to(roomId).emit('matchFound', { roomId, state: gameState });
                startGameLoop(roomId);
            } else socket.emit('waiting', `Очікування гравців (${queue.length}/${mode * 2})...`);
        } catch (err) {}
    });

    socket.on('cancelMatchMatchmaking', () => { [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); }); });

    socket.on('spectateRandom', () => {
        const activeRoomsIds = Object.keys(rooms);
        if (activeRoomsIds.length === 0) { socket.emit('spectateError', 'Зараз немає активних ігор 😔'); return; }
        const randomRoomId = activeRoomsIds[Math.floor(Math.random() * activeRoomsIds.length)];
        socket.join(randomRoomId);
        socket.emit('spectateStart', { roomId: randomRoomId, state: rooms[randomRoomId].state });
    });

    socket.on('input', (data) => {
        try {
            if (!data || !data.roomId || !rooms[data.roomId]) return;
            const player = rooms[data.roomId].state.players[socket.id];
            if (player && !player.isBot) {
                player.lastMoveTime = Date.now();
                player.isDragging = data.dragging;
                if (data.dragging) { player.tx = Number(data.tx); player.ty = Number(data.ty); }
            }
        } catch (err) {}
    });

    socket.on('pongTimer', (timestamp) => {
        for (const roomId in rooms) {
            const p = rooms[roomId].state.players[socket.id];
            if (p) { p.ping = Date.now() - timestamp; break; }
        }
    });

    socket.on('chatMessage', (data) => {
        if (rooms[data.roomId]) io.to(data.roomId).emit('chatMessage', { sender: data.sender, text: data.text });
    });

    socket.on('disconnect', () => {
        ipConnections[ip]--; totalOnline--; io.emit('onlineCount', totalOnline);
        [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); });
        for (const roomId in rooms) {
            if (rooms[roomId].players.includes(socket.id)) {
                const p = rooms[roomId].state.players[socket.id];
                if (p) p.isBot = true;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущено: http://localhost:${PORT}`));
