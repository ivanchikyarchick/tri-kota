const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const WIDTH = 1200;
const HEIGHT = 600;
const PLAYER_RADIUS = 40; 
const PUCK_RADIUS = 20;
const FRICTION = 0.985; 
const GOAL_HEIGHT = 150; 
const WALL_PADDING = 25; // Відступ стін на зображенні

// База користувачів у пам'яті
const usersDb = {}; // { username: password }
const rooms = {};

// Черги для різних режимів (1 = 1v1, 2 = 2v2, 3 = 3v3)
const queues = { 1: [], 2: [], 3: [] };

function initGameState() {
    return {
        players: {}, // { socketId: { x, y, char, team, username } }
        puck: { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0 },
        score: { team1: 0, team2: 0 },
        goalTriggered: false
    };
}

function handleCollision(p1, p2, radius1, radius2, isPuck = false) {
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let distance = Math.sqrt(dx * dx + dy * dy);
    let minDist = radius1 + radius2;

    if (distance < minDist) {
        let angle = Math.atan2(dy, dx);
        if (isPuck) {
            let kickForce = 18;
            p2.vx = Math.cos(angle) * kickForce;
            p2.vy = Math.sin(angle) * kickForce;
            p2.x = p1.x + Math.cos(angle) * minDist;
            p2.y = p1.y + Math.sin(angle) * minDist;
        } else {
            // Зіткнення гравців між собою (щоб не проїжджали крізь один одного)
            let overlap = minDist - distance;
            p1.x -= Math.cos(angle) * (overlap / 2);
            p1.y -= Math.sin(angle) * (overlap / 2);
            p2.x += Math.cos(angle) * (overlap / 2);
            p2.y += Math.sin(angle) * (overlap / 2);
        }
    }
}

function resetAfterGoal(roomId, scorerChar) {
    const game = rooms[roomId];
    io.to(roomId).emit('goal', scorerChar);
    
    setTimeout(() => {
        if(game && game.state) {
            game.state.puck = { x: WIDTH/2, y: HEIGHT/2, vx: 0, vy: 0 };
            game.state.goalTriggered = false;
            
            // Розставляємо гравців по своїх зонах
            let t1Count = 0, t2Count = 0;
            for (let id in game.state.players) {
                let p = game.state.players[id];
                if (p.team === 1) {
                    p.x = 150 + (t1Count * 50); p.y = 300 + (t1Count * 50);
                    t1Count++;
                } else {
                    p.x = 1050 - (t2Count * 50); p.y = 300 + (t2Count * 50);
                    t2Count++;
                }
            }
        }
    }, 2500);
}

function startGameLoop(roomId) {
    const game = rooms[roomId];
    if (game.loopInterval) return;

    game.loopInterval = setInterval(() => {
        const state = game.state;
        const puck = state.puck;

        // Фізика шайби
        puck.x += puck.vx; puck.y += puck.vy;
        puck.vx *= FRICTION; puck.vy *= FRICTION;

        // Межі для шайби (З врахуванням WALL_PADDING)
        if (puck.y - PUCK_RADIUS < WALL_PADDING) { puck.y = PUCK_RADIUS + WALL_PADDING; puck.vy *= -0.8; } 
        else if (puck.y + PUCK_RADIUS > HEIGHT - WALL_PADDING) { puck.y = HEIGHT - PUCK_RADIUS - WALL_PADDING; puck.vy *= -0.8; }

        if (puck.y > HEIGHT / 2 - GOAL_HEIGHT / 2 && puck.y < HEIGHT / 2 + GOAL_HEIGHT / 2) {
            if (puck.x - PUCK_RADIUS < WALL_PADDING && !state.goalTriggered) {
                state.score.team2++; state.goalTriggered = true; 
                resetAfterGoal(roomId, 'karamelka'); return; // Умовно показуємо Карамельку для Team2
            } else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING && !state.goalTriggered) {
                state.score.team1++; state.goalTriggered = true; 
                resetAfterGoal(roomId, 'korzhik'); return;
            }
        } else {
            if (puck.x - PUCK_RADIUS < WALL_PADDING) { puck.x = PUCK_RADIUS + WALL_PADDING; puck.vx *= -0.8; } 
            else if (puck.x + PUCK_RADIUS > WIDTH - WALL_PADDING) { puck.x = WIDTH - PUCK_RADIUS - WALL_PADDING; puck.vx *= -0.8; }
        }

        // Зіткнення шайби з гравцями
        for (let id in state.players) {
            handleCollision(state.players[id], puck, PLAYER_RADIUS, PUCK_RADIUS, true);
        }

        io.to(roomId).emit('gameState', state);
    }, 1000 / 60);
}

io.on('connection', (socket) => {
    
    // АВТОРИЗАЦІЯ
    socket.on('register', ({ username, password }) => {
        if (usersDb[username]) return socket.emit('authResult', { success: false, msg: 'Имя уже занято!' });
        usersDb[username] = password;
        socket.emit('authResult', { success: true, username });
    });

    socket.on('login', ({ username, password }) => {
        if (usersDb[username] && usersDb[username] === password) {
            socket.emit('authResult', { success: true, username });
        } else {
            socket.emit('authResult', { success: false, msg: 'Неверный логин или пароль!' });
        }
    });

    // ПОШУК ГРИ
    socket.on('findMatch', (data) => {
        const mode = data.mode; // 1, 2 або 3
        const queue = queues[mode];
        
        // Перевірка, чи гравець вже не в черзі
        if (!queue.find(p => p.socket.id === socket.id)) {
            queue.push({ socket, data });
        }

        const requiredPlayers = mode * 2; // 2 для 1v1, 4 для 2v2, 6 для 3v3

        if (queue.length >= requiredPlayers) {
            const playersInMatch = queue.splice(0, requiredPlayers);
            const roomId = `room_${Date.now()}`;
            const gameState = initGameState();

            playersInMatch.forEach((p, index) => {
                p.socket.join(roomId);
                const team = (index < mode) ? 1 : 2; // Перша половина в команду 1, друга в команду 2
                
                gameState.players[p.socket.id] = {
                    x: team === 1 ? 150 : 1050,
                    y: 300 + (index * 20),
                    char: p.data.character,
                    team: team,
                    username: p.data.username
                };
                
                io.to(p.socket.id).emit('matchFound', { roomId, myTeam: team, mode: mode });
            });

            rooms[roomId] = { state: gameState, players: playersInMatch.map(p => p.socket.id) };
            startGameLoop(roomId);
        } else {
            socket.emit('waiting', `Ожидание игроков (${queue.length}/${requiredPlayers})...`);
        }
    });

    // РУХ І ОБМЕЖЕННЯ
    socket.on('move', (data) => {
        if (!data.roomId || !rooms[data.roomId]) return;
        const state = rooms[data.roomId].state;
        const player = state.players[socket.id];
        
        if (player) {
            // Межі карти для гравців
            let minX = player.team === 1 ? WALL_PADDING + PLAYER_RADIUS : WIDTH / 2 + PLAYER_RADIUS;
            let maxX = player.team === 1 ? WIDTH / 2 - PLAYER_RADIUS : WIDTH - WALL_PADDING - PLAYER_RADIUS;
            let minY = WALL_PADDING + PLAYER_RADIUS;
            let maxY = HEIGHT - WALL_PADDING - PLAYER_RADIUS;

            player.x = Math.max(minX, Math.min(data.position.x, maxX));
            player.y = Math.max(minY, Math.min(data.position.y, maxY));
        }
    });

    socket.on('disconnect', () => {
        [1, 2, 3].forEach(mode => {
            queues[mode] = queues[mode].filter(p => p.socket.id !== socket.id);
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));