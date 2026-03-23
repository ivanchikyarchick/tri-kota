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

// База користувачів
const usersDb = {}; 
const rooms = {};
const queues = { 1: [], 2: [], 3: [] };
let totalOnline = 0; 

// АНТИ-БОТ
const ipConnections = {};

function initGameState() {
    return { players: {}, puck: { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0 }, score: { team1: 0, team2: 0 }, goalTriggered: false };
}

function handleCollision(p1, p2, radius1, radius2, isPuck = false) {
    if (!p1 || !p2 || isNaN(p1.x) || isNaN(p2.x)) return;
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    let distance = Math.sqrt(dx * dx + dy * dy), minDist = radius1 + radius2;

    if (distance < minDist) {
        let angle = Math.atan2(dy, dx);
        if (isPuck) {
            let kickForce = 18;
            p2.vx = Math.cos(angle) * kickForce; p2.vy = Math.sin(angle) * kickForce;
            p2.x = p1.x + Math.cos(angle) * minDist; p2.y = p1.y + Math.sin(angle) * minDist;
        } else {
            let overlap = minDist - distance;
            p1.x -= Math.cos(angle) * (overlap / 2); p1.y -= Math.sin(angle) * (overlap / 2);
            p2.x += Math.cos(angle) * (overlap / 2); p2.y += Math.sin(angle) * (overlap / 2);
        }
    }
}

function resetAfterGoal(roomId, scorerChar) {
    const game = rooms[roomId];
    if (!game) return;
    io.to(roomId).emit('goal', scorerChar);
    setTimeout(() => {
        if(game && game.state) {
            game.state.puck = { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0 };
            game.state.goalTriggered = false;
            let t1Count = 0, t2Count = 0;
            for (let id in game.state.players) {
                let p = game.state.players[id];
                if (p.team === 1) { p.x = 150 + (t1Count * 50); p.y = 300 + (t1Count * 50); t1Count++; } 
                else { p.x = 1050 - (t2Count * 50); p.y = 300 + (t2Count * 50); t2Count++; }
            }
        }
    }, 2500);
}

function updateElo(roomId, finalScore) {
    const game = rooms[roomId];
    if (!game || game.eloAwarded) return;
    game.eloAwarded = true;

    for (let id in game.state.players) {
        let p = game.state.players[id];
        let dbUser = usersDb[p.username];
        if (!dbUser) continue;

        let eloChange = 0;
        if (finalScore.team1 === finalScore.team2) {
            eloChange = +10; 
        } else if ((p.team === 1 && finalScore.team1 > finalScore.team2) || (p.team === 2 && finalScore.team2 > finalScore.team1)) {
            eloChange = +45; 
        } else {
            eloChange = -15; 
        }

        dbUser.elo += eloChange;
        if (dbUser.elo < 0) dbUser.elo = 0;

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
                clearInterval(game.loopInterval);
                updateElo(roomId, game.state.score); 
                io.to(roomId).emit('gameOver', game.state.score); 
                delete rooms[roomId];
                return;
            }

            const state = game.state;
            const puck = state.puck;

            if (isNaN(puck.x) || isNaN(puck.y) || Math.abs(puck.x) > 3000) {
                puck.x = WIDTH / 2; puck.y = HEIGHT / 2; puck.vx = 0; puck.vy = 0;
            }

            puck.x += puck.vx; puck.y += puck.vy;
            puck.vx *= FRICTION; puck.vy *= FRICTION;

            if (puck.y - PUCK_RADIUS < WALL_PADDING) { puck.y = PUCK_RADIUS + WALL_PADDING; puck.vy *= -0.8; } 
            else if (puck.y + PUCK_RADIUS > HEIGHT - WALL_PADDING) { puck.y = HEIGHT - PUCK_RADIUS - WALL_PADDING; puck.vy *= -0.8; }

            if (puck.y > HEIGHT / 2 - GOAL_HEIGHT / 2 && puck.y < HEIGHT / 2 + GOAL_HEIGHT / 2) {
                if (puck.x - PUCK_RADIUS < WALL_PADDING && !state.goalTriggered) {
                    state.score.team2++; state.goalTriggered = true; resetAfterGoal(roomId, 'karamelka'); 
                } else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING && !state.goalTriggered) {
                    state.score.team1++; state.goalTriggered = true; resetAfterGoal(roomId, 'korzhik'); 
                }
            } else {
                if (puck.x - PUCK_RADIUS < WALL_PADDING) { puck.x = PUCK_RADIUS + WALL_PADDING; puck.vx *= -0.8; } 
                else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING) { puck.x = WIDTH - PUCK_RADIUS - WALL_PADDING; puck.vx *= -0.8; }
            }
            if (state.goalTriggered) { puck.vx *= 0.5; puck.vy *= 0.5; }

            let now = Date.now();
            for (let id in state.players) {
                let p = state.players[id];
                
                if (!p.isBot && now - p.lastMoveTime > 15000) {
                    p.isBot = true;
                    io.to(id).emit('afkWarning'); 
                }

                if (p.isBot && !state.goalTriggered) {
                    let targetX = p.team === 1 ? 200 : WIDTH - 200; 
                    let targetY = HEIGHT / 2;

                    if ((p.team === 1 && puck.x < WIDTH / 2 + 100) || (p.team === 2 && puck.x > WIDTH / 2 - 100)) {
                        targetX = puck.x; targetY = puck.y;
                    }

                    p.x += (targetX - p.x) * 0.05;
                    p.y += (targetY - p.y) * 0.05;

                    let minX = p.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS;
                    let maxX = p.team === 1 ? WIDTH / 2 - PLAYER_RADIUS : WIDTH - WALL_PADDING - PLAYER_RADIUS;
                    p.x = Math.max(minX, Math.min(p.x, maxX));
                    p.y = Math.max(WALL_PADDING + PLAYER_RADIUS, Math.min(p.y, HEIGHT - WALL_PADDING - PLAYER_RADIUS));
                }
                handleCollision(p, puck, PLAYER_RADIUS, PUCK_RADIUS, true);
            }

            const miniState = { p: {}, u: { x: Math.round(puck.x), y: Math.round(puck.y) }, s: state.score, t: remainingSeconds };
            for (let id in state.players) {
                if (state.players[id] && !isNaN(state.players[id].x)) {
                    miniState.p[id] = { x: Math.round(state.players[id].x), y: Math.round(state.players[id].y), ping: state.players[id].ping || 0, isBot: state.players[id].isBot };
                }
            }
            io.to(roomId).emit('gs', miniState); 

        } catch (err) { console.error("Помилка циклу:", err); }
    }, 1000 / 30); 
}

setInterval(() => { io.emit('pingTimer', Date.now()); }, 2000);

io.on('connection', (socket) => {
    // ВДОСКОНАЛЕНИЙ АНТИ-БОТ (Беремо справжній IP)
    let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (typeof ip === 'string') ip = ip.split(',')[0].trim(); // Якщо IP кілька, беремо перший

    if (!ipConnections[ip]) ipConnections[ip] = 0;
    ipConnections[ip]++;
    
    // Ліміт піднято до 15!
    if (ipConnections[ip] > 15) {
        console.warn(`[АНТИ-БОТ] Заблоковано IP: ${ip}`);
        socket.disconnect(true);
        return;
    }

    totalOnline++;
    io.emit('onlineCount', totalOnline);

    socket.on('register', ({ username, password }) => {
        if (usersDb[username]) return socket.emit('authResult', { success: false, msg: 'Имя уже занято!' });
        usersDb[username] = { password: password, elo: 1000 }; 
        socket.emit('authResult', { success: true, username, elo: 1000 });
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
                const playersInMatch = queue.splice(0, mode * 2);
                const roomId = `room_${Date.now()}`;
                const gameState = initGameState();

                playersInMatch.forEach((p, index) => {
                    p.socket.join(roomId);
                    const team = (index < mode) ? 1 : 2; 
                    gameState.players[p.socket.id] = { 
                        x: team === 1 ? 150 : 1050, y: 300 + (index * 20), char: p.data.character, team: team, 
                        username: p.data.username, ping: 0, lastMoveTime: Date.now(), isBot: false 
                    };
                });
                rooms[roomId] = { state: gameState, players: playersInMatch.map(p => p.socket.id), endTime: Date.now() + 180 * 1000, eloAwarded: false };
                io.to(roomId).emit('matchFound', { roomId, state: gameState });
                startGameLoop(roomId);
            } else { socket.emit('waiting', `Ожидание игроков (${queue.length}/${mode * 2})...`); }
        } catch(err) {}
    });

    socket.on('cancelMatchMatchmaking', () => { [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); }); });
    
    socket.on('spectateRandom', () => {
        const activeRoomsIds = Object.keys(rooms);
        if (activeRoomsIds.length === 0) { socket.emit('spectateError', 'Сейчас нет активных игр 😔'); return; }
        const randomRoomId = activeRoomsIds[Math.floor(Math.random() * activeRoomsIds.length)];
        socket.join(randomRoomId); socket.emit('spectateStart', { roomId: randomRoomId, state: rooms[randomRoomId].state });
    });

    socket.on('move', (data) => {
        try {
            if (!data || !data.roomId || !rooms[data.roomId] || !data.position) return;
            const player = rooms[data.roomId].state.players[socket.id];
            if (player && !player.isBot) { 
                let px = Number(data.position.x), py = Number(data.position.y);
                if (isNaN(px) || isNaN(py)) return; 
                
                player.lastMoveTime = Date.now(); 

                let minX = player.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS;
                let maxX = player.team === 1 ? WIDTH / 2 - PLAYER_RADIUS : WIDTH - WALL_PADDING - PLAYER_RADIUS;
                let minY = WALL_PADDING + PLAYER_RADIUS, maxY = HEIGHT - WALL_PADDING - PLAYER_RADIUS;
                
                player.x = Math.max(minX, Math.min(px, maxX)); player.y = Math.max(minY, Math.min(py, maxY));
            }
        } catch(err) {}
    });

    socket.on('pongTimer', (timestamp) => {
        for (let roomId in rooms) { let p = rooms[roomId].state.players[socket.id]; if (p) { p.ping = Date.now() - timestamp; break; } }
    });
    
    socket.on('chatMessage', (data) => { if (rooms[data.roomId]) io.to(data.roomId).emit('chatMessage', { sender: data.sender, text: data.text }); });

    socket.on('disconnect', () => {
        ipConnections[ip]--; // Зменшуємо лічильник при виході
        totalOnline--;
        io.emit('onlineCount', totalOnline);
        [1, 2, 3].forEach(mode => { queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id); });
        
        for (const roomId in rooms) {
            if (rooms[roomId].players.includes(socket.id)) {
                if(rooms[roomId].state.players[socket.id]) {
                    rooms[roomId].state.players[socket.id].isBot = true;
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
